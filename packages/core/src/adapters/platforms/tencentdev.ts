/**
 * 腾讯云开发者社区原站 (cloud.tencent.com/developer) 适配器
 *
 * 说明:
 * - 与 tencentcloud(devpress.csdn.net 副本页) 是两个不同站点，独立 id 并存
 * - 正文走 Markdown，服务端信封是 <!--markdown--> ... <!--/markdown-->
 * - 正文里的 http(s) 外链图片由服务端在发布时转存为 developer.qcloudimg.com 图床，
 *   适配器不用管；只有 data URI（本地图内联）必须自己传 COS
 * - 编辑器本地图上传走私有桶，markdown 里放的是带签名的临时 GET 链接，
 *   服务端发布时能读到自己签的 URL，再转存成公链
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('TencentDev')

const SITE = 'https://cloud.tencent.com'
const API = `${SITE}/developer/api`

/** 图片来源: 1=原创 2=转载 3=翻译 */
const SOURCE_TYPE_ORIGINAL = 1

const MD_ENVELOPE_PREFIX = '<!--markdown-->\n'
const MD_ENVELOPE_SUFFIX = '\n<!--/markdown-->'

/** COS 只收这几种图片，与服务端编辑器限制一致 */
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
}

const SUMMARY_LIMIT = 200

interface ApiError {
  code?: number
  msg?: string
  message?: string
}

interface UploadInfo extends ApiError {
  bucket?: string
  region?: string
  objectKey?: string
  isPrivateBucket?: boolean
}

interface TmpSecret extends ApiError {
  credentials?: { TmpSecretId?: string; TmpSecretKey?: string; Token?: string }
  startTime?: number
  expiredTime?: number
}

interface DraftResp extends ApiError {
  draftId?: number
}

interface PublishResp extends ApiError {
  articleId?: number
  status?: number
}

interface TagItem {
  tagId: number
  tagName: string
}

export class TencentDevAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'tencentdev',
    name: '腾讯云社区(原站)',
    icon: `${SITE}/favicon.ico`,
    homepage: `${SITE}/developer/article/write-new`,
    capabilities: ['article', 'draft', 'image_upload', 'tags'],
  }

  /** 原站编辑器以 Markdown 为准 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 服务端校验 Origin/Referer 来自本站，扩展发起的请求必须伪装 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://cloud.tencent.com/developer/api/*',
      headers: {
        Origin: SITE,
        Referer: `${SITE}/developer/article/write-new`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.postJson<{ qcloudUid?: string }>(
        `${API}/user/get-user-qcloud-uid`,
        {}
      )

      if (res?.qcloudUid) {
        return {
          isAuthenticated: true,
          userId: String(res.qcloudUid),
          username: `腾讯云用户 ${res.qcloudUid}`,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      // 未登录时服务端直接返回 HTTP 401
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, () => this.doPublish(article, options))
  }

  private async doPublish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting publish...')

      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录腾讯云开发者社区')
      }

      const markdown = await this.processImages(article.markdown || '', src =>
        this.uploadImageByUrl(src)
      )

      if (markdown.includes('data:image')) {
        throw new Error('[图片上传] 有图片未传成功，正文仍残留 base64，已中止发布（原因见扩展日志）')
      }

      const text = toReadableText(markdown)
      const plain = text.replace(/\s+/g, '')
      const summary = (article.summary || firstParagraph(text)).slice(0, SUMMARY_LIMIT)
      const tagIds = await this.resolveTagIds(article.tags)

      const draftOnly = options?.draftOnly ?? true

      if (draftOnly) {
        const res = await this.postJson<DraftResp>(`${API}/article/addArticleDraft`, {
          articleId: 0,
          title: article.title,
          content: wrapMarkdown(markdown),
          plain,
          sourceType: SOURCE_TYPE_ORIGINAL,
          classifyIds: [],
          tagIds,
          longtailTag: [],
          columnIds: [],
          openComment: 1,
          closeTextLink: 0,
          userSummary: summary,
          pic: '',
          sourceDetail: {},
          zoneName: '',
          summary,
        })

        logger.debug('Draft response:', res)

        if (!res.draftId) {
          throw new Error(`[创建草稿] ${res.msg || res.message || '服务端未返回 draftId'}`)
        }

        return this.createResult(true, {
          postId: String(res.draftId),
          postUrl: `${SITE}/developer/article/write-new?draftId=${res.draftId}`,
          draftOnly: true,
        })
      }

      const res = await this.postJson<PublishResp>(`${API}/article/addArticle`, {
        title: article.title,
        content: wrapMarkdown(markdown),
        columnIds: [],
        classifyIds: [],
        sourceType: SOURCE_TYPE_ORIGINAL,
        tagIds,
        longtailTag: [],
        plain,
        pic: '',
        userSummary: summary,
        banComment: 0,
        closeArticleTextLink: 0,
        zoneName: '',
        vlogIds: [],
        summary,
        draftId: 0,
      })

      logger.debug('Publish response:', res)

      if (!res.articleId) {
        throw new Error(`[发布文章] ${res.msg || res.message || '服务端未返回 articleId'}`)
      }

      return this.createResult(true, {
        postId: String(res.articleId),
        postUrl: `${SITE}/developer/article/${res.articleId}`,
        draftOnly: false,
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  /**
   * 标签是平台侧 ID，只能拿文章自带标签名去搜出来；搜不到就不带，服务端接受空数组
   */
  private async resolveTagIds(tags?: string[]): Promise<number[]> {
    const ids: number[] = []

    for (const tag of tags || []) {
      const keyword = tag.trim()
      if (!keyword || ids.length >= 5) continue

      try {
        const res = await this.postJson<{ list?: TagItem[] } | TagItem[]>(
          `${API}/tag/search`,
          { keyword, limit: 5 }
        )
        const list = Array.isArray(res) ? res : res?.list || []
        const hit = list.find(t => t.tagName === keyword) || list[0]

        if (hit?.tagId && !ids.includes(hit.tagId)) ids.push(hit.tagId)
      } catch (error) {
        logger.warn(`标签检索失败 ${keyword}:`, error)
      }
    }

    return ids
  }

  /**
   * 图片：外链交给服务端发布时转存，data URI 必须自己直传 COS 私有桶再签名回链
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!src.startsWith('data:')) return { url: src }

    const bytes = await (await fetch(src)).blob()
    const ext = IMAGE_MIME_EXT[bytes.type]
    if (!ext) {
      throw new Error(`[图片上传] 腾讯云社区仅支持 png/jpg/jpeg/gif 图片，收到 ${bytes.type || '未知类型'}`)
    }

    const info = await this.postJson<UploadInfo>(`${API}/common/cos/upload-info`, {
      scene: 'editor.image',
      extension: ext,
    })

    if (!info.objectKey || !info.bucket || !info.region) {
      throw new Error(`[图片上传] 获取上传凭证失败: ${info.msg || info.message || '响应缺少桶信息'}`)
    }

    const key = info.objectKey.replace(/^\/+/, '')
    const secret = await this.postJson<TmpSecret>(`${API}/common/cos/tmp-secret`, {
      objectKey: info.objectKey,
    })

    const cred = secret.credentials
    if (!cred?.TmpSecretId || !cred.TmpSecretKey || !cred.Token || !secret.startTime || !secret.expiredTime) {
      throw new Error(`[图片上传] 获取临时密钥失败: ${secret.msg || secret.message || '响应不完整'}`)
    }

    const host = `${info.bucket}.cos.${info.region}.myqcloud.com`
    const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const auth = await buildCosAuthorization({
      method: 'put',
      host,
      key,
      keyTime: `${secret.startTime};${secret.expiredTime}`,
      secretId: cred.TmpSecretId,
      secretKey: cred.TmpSecretKey,
      headers: {
        'cache-control': 'max-age=315360000',
        'content-type': contentType,
      },
    })

    const put = await this.runtime.fetch(`https://${host}/${key}`, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'max-age=315360000',
        'x-cos-security-token': cred.Token,
        Authorization: auth,
      },
      body: bytes,
    })

    if (!put.ok) {
      throw new Error(`[图片上传] 直传 COS 失败 HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`)
    }

    // 私有桶只能靠签名 GET 外链访问，服务端发布时会把这行转存成公链
    const signed = await buildCosSignedUrl({
      method: 'get',
      host,
      key,
      keyTime: `${secret.startTime};${secret.expiredTime}`,
      secretId: cred.TmpSecretId,
      secretKey: cred.TmpSecretKey,
      token: cred.Token,
      headers: {},
    })

    logger.debug(`COS 上传成功: ${key}`)

    return { url: signed }
  }
}

function wrapMarkdown(markdown: string): string {
  return `${MD_ENVELOPE_PREFIX}${markdown}${MD_ENVELOPE_SUFFIX}`
}

/** markdown 去掉格式符号后的可读纯文本，服务端用它做摘要/查重（plain 字段则是它再去掉所有空白） */
function toReadableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/<[a-zA-Z/][^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 摘要缺省时取正文第一段 */
function firstParagraph(text: string): string {
  const para = text.split('\n').find(l => l.trim().length > 0) || ''
  return para.trim()
}

// ============ COS 签名 ============

const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(text))
  return toHex(digest)
}

async function hmacSha1Hex(key: string, text: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: { name: 'SHA-1' } },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text))
  return toHex(signature)
}

/** COS 严格 RFC3986 编码，签名值与最终 URL 必须完全一致 */
function cosEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
}

interface CosSignInput {
  method: string
  host: string
  key: string
  keyTime: string
  secretId: string
  secretKey: string
  token?: string
  headers: Record<string, string>
  urlParams?: Record<string, string>
}

async function cosSignature(input: CosSignInput, signTime: string): Promise<string> {
  const headerKeys = Object.keys(input.headers).map(k => k.toLowerCase()).sort()
  const headerList = headerKeys.join(';')
  const headerString = headerKeys
    .map(k => `${k}=${cosEncode(input.headers[k])}`)
    .join('&')
  const paramKeys = Object.keys(input.urlParams || {}).map(k => k.toLowerCase()).sort()
  const urlParamList = paramKeys.join(';')
  const paramString = paramKeys
    .map(k => `${k}=${cosEncode((input.urlParams || {})[k])}`)
    .join('&')

  const httpString = `${input.method}\n/${input.key}\n${paramString}\n${headerString}\n`
  const stringToSign = `sha1\n${signTime}\n${await sha1Hex(httpString)}\n`
  const signKey = await hmacSha1Hex(input.secretKey, input.keyTime)
  const signature = await hmacSha1Hex(signKey, stringToSign)

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${input.secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${input.keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${urlParamList}`,
    `q-signature=${signature}`,
  ].join('&')
}

/** PUT 走 Header 里的 Authorization */
function buildCosAuthorization(input: CosSignInput): Promise<string> {
  return cosSignature(input, input.keyTime)
}

/** GET 走 query 预签名，私有桶对象靠它才能被服务端抓到 */
async function buildCosSignedUrl(input: CosSignInput): Promise<string> {
  const token = input.token || ''
  const query = await cosSignature(
    { ...input, headers: {}, urlParams: { 'x-cos-security-token': token } },
    input.keyTime
  )
  return `https://${input.host}/${input.key}?${query}&x-cos-security-token=${cosEncode(token)}`
}
