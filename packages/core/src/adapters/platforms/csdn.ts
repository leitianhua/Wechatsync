/**
 * CSDN 适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('CSDN')

interface CSDNUserInfo {
  csdnid: string
  username: string
  avatarurl: string
}

export class CSDNAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'csdn',
    name: 'CSDN',
    icon: 'https://g.csdnimg.cn/static/logo/favicon32.ico',
    homepage: 'https://editor.csdn.net/md/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: CSDN 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private userInfo: CSDNUserInfo | null = null

  // CSDN API 签名密钥
  private readonly API_KEY = '203803574'
  private readonly API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

  /** CSDN API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://bizapi.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imgservice.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用带签名的 API
      const apiPath = '/blog-console-api/v3/editor/getBaseInfo'
      const headers = await this.signRequest(apiPath, 'GET')

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'GET',
          credentials: 'include',
          headers,
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          name: string
          nickname: string
          avatar: string
          blog_url: string
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code === 200 && res.data?.name) {
        this.userInfo = {
          csdnid: res.data.name,
          username: res.data.nickname || res.data.name,
          avatarurl: res.data.avatar,
        }
        return {
          isAuthenticated: true,
          userId: res.data.name,
          username: res.data.nickname || res.data.name,
          avatar: res.data.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 生成 UUID
   */
  private createUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /**
   * HMAC-SHA256 签名 (使用 Web Crypto API)
   */
  private async hmacSha256(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)

    // 转换为 Base64
    const bytes = new Uint8Array(signature)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * 生成 CSDN API 签名
   * 签名格式: METHOD\nAccept\nContent-MD5\nContent-Type\n\nHeaders\nPath
   */
  private async signRequest(apiPath: string, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, string>> {
    const nonce = this.createUuid()

    // GET: 没有 Content-Type，所以那一行为空
    // POST: Content-Type 为 application/json
    const signStr = method === 'GET'
      ? `GET\n*/*\n\n\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`
      : `POST\n*/*\n\napplication/json\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`

    logger.debug('Sign string:', JSON.stringify(signStr))

    const signature = await this.hmacSha256(signStr, this.API_SECRET)

    const headers: Record<string, string> = {
      'accept': '*/*',
      'x-ca-key': this.API_KEY,
      'x-ca-nonce': nonce,
      'x-ca-signature': signature,
      'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
    }

    if (method === 'POST') {
      headers['content-type'] = 'application/json'
    }

    return headers
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录 CSDN')
        }
      }

      // markdown 与 html 中的图片都要换成图床外链，用缓存避免同一张图重复上传
      const uploaded = new Map<string, ImageUploadResult>()
      const uploadFn = async (src: string): Promise<ImageUploadResult> => {
        const cached = uploaded.get(src)
        if (cached) return cached

        const result = await this.uploadImageByUrl(src)
        uploaded.set(src, result)
        return result
      }

      // 正文里的图片（含 CLI 内联的 data URI）必须全部换成图床外链，
      // 否则 base64 会原样进入请求体，被 CSDN 以「正文字数太多」拒绝
      const markdown = await this.processImages(article.markdown || '', uploadFn, {
        skipPatterns: ['csdnimg.cn', 'csdn.net'],
        onProgress: options?.onImageProgress,
      })

      // CSDN 的 content 字段同样参与长度校验，要与 markdown 一样清洗
      const htmlContent = await this.processImages(article.html || '', uploadFn)

      const draftOnly = options?.draftOnly ?? true

      // Generate signature and save article
      const apiPath = '/blog-console-api/v3/mdeditor/saveArticle'
      const headers = await this.signRequest(apiPath)

      const bodyBase = {
        title: article.title,
        markdowncontent: markdown,
        content: htmlContent,
        readType: 'public',
        level: 0,
        tags: '',
        categories: '',
        type: 'original',
        original_link: '',
        authorized_status: false,
        not_auto_saved: '1',
        source: 'pc_mdeditor',
        cover_images: [],
        cover_type: 1,
        is_new: 1,
        vote_id: 0,
        resource_id: '',
        creator_activity_id: '',
      }

      // 抓包实测(2026-09-21): 直发强制要求标签非空，且 tags 是逗号拼接字符串（如 "python,爬虫"），
      // 传数组会得到笼统的「Bad Request」；草稿模式不校验标签。
      // 兜底标签由用户指定（2026-09-21）
      const tagStr = (article.tags && article.tags.length ? article.tags : ['笔记', '经验分享']).slice(0, 3).join(',')

      // 抓包实测: 编辑器直发是两步——先存草稿拿到文章 id，再带 id 调同一端点发布；
      // 且直发要多带 Description(正文前256字摘要)/resource_url/creation_statement/template_id/sync_git_code
      const plainText = (article.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      const description = plainText.substring(0, 256)

      const url = `https://bizapi.csdn.net${apiPath}`

      // 第一步：存草稿（直发也需要草稿返回的文章 id；draftOnly 时这就是最终动作）
      const draftBody = { ...bodyBase, status: 2, pubStatus: 'draft' }
      const draftResponse = await this.runtime.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(draftBody),
      })
      const draftRes = await draftResponse.json() as {
        code: number
        message?: string
        msg?: string
        data?: { id: string | number }
      }
      logger.debug('Draft response:', draftRes)
      if (draftRes.code !== 200 || !draftRes.data?.id) {
        throw new Error(draftRes.msg || draftRes.message || '保存草稿失败')
      }
      const postId = String(draftRes.data.id)

      if (draftOnly) {
        return this.createResult(true, {
          postId: postId,
          postUrl: `https://editor.csdn.net/md?articleId=${postId}`,
          draftOnly: true,
        })
      }

      // 第二步：带 id 正式发布（字段形态对齐编辑器抓包: level 为字符串、tags 为逗号字符串）
      const publishHeaders = await this.signRequest(apiPath)
      const publishBody = {
        ...bodyBase,
        id: postId,
        level: '0',
        tags: tagStr,
        Description: description,
        resource_url: '',
        status: 0,
        pubStatus: 'publish',
        creation_statement: 0,
        template_id: -1,
        sync_git_code: 0,
      }
      const response = await this.runtime.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: publishHeaders,
        body: JSON.stringify(publishBody),
      })

      const res = await response.json() as {
        code: number
        message?: string
        msg?: string
        data?: { id: string | number; url?: string }
      }

      logger.debug('Publish response:', res)

      if (res.code !== 200 || !res.data?.id) {
        throw new Error(res.msg || res.message || '发布失败')
      }

      const username = this.userInfo?.csdnid

      // 直发已上架：优先用响应里的线上地址，其次拼博客页，拿不到用户名时回退编辑器地址
      const postUrl = res.data.url
        || (username
          ? `https://blog.csdn.net/${username}/article/details/${postId}`
          : `https://editor.csdn.net/md?articleId=${postId}`)

      return this.createResult(true, {
        postId: postId,
        postUrl: postUrl,
        draftOnly: false,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   * 需要设置动态请求头规则以支持 MCP 调用
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 转为 data URI 然后调用 uploadImageByUrl
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await this.uploadImageByUrl(dataUri)
      return result.url
    })
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 获取文件扩展名
    const ext = src.split('.').pop()?.toLowerCase()?.split('?')[0] || 'jpg'
    const validExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg'

    // 3. 获取上传签名 (新 API: bizapi.csdn.net)
    const apiPath = '/resource-api/v1/image/direct/upload/signature'
    const headers = await this.signRequest(apiPath, 'POST')

    const signatureRes = await this.runtime.fetch(
      `https://bizapi.csdn.net${apiPath}`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          imageTemplate: '',
          appName: 'direct_blog_markdown',
          imageSuffix: validExt,
        }),
      }
    )

    const signatureData = await signatureRes.json() as {
      code: number
      data?: {
        filePath: string
        host: string
        accessId: string
        policy: string
        signature: string
        callbackUrl: string
        callbackBody: string
        callbackBodyType: string
        customParam: {
          rtype: string
          filePath: string
          isAudit: number
          'x-image-app': string
          type: string
          'x-image-suffix': string
          username: string
        }
      }
    }

    logger.debug('Upload signature response:', signatureData)

    if (signatureData.code !== 200 || !signatureData.data) {
      logger.warn('Failed to get upload signature, using original URL')
      return { url: src }
    }

    const uploadData = signatureData.data
    const customParam = uploadData.customParam

    // 4. 上传到华为云 OBS
    const formData = new FormData()
    formData.append('key', uploadData.filePath)
    formData.append('policy', uploadData.policy)
    formData.append('signature', uploadData.signature)
    formData.append('callbackBody', uploadData.callbackBody)
    formData.append('callbackBodyType', uploadData.callbackBodyType)
    formData.append('callbackUrl', uploadData.callbackUrl)
    formData.append('AccessKeyId', uploadData.accessId)
    formData.append('x:rtype', customParam.rtype)
    formData.append('x:filePath', customParam.filePath)
    formData.append('x:isAudit', String(customParam.isAudit))
    formData.append('x:x-image-app', customParam['x-image-app'])
    formData.append('x:type', customParam.type)
    formData.append('x:x-image-suffix', customParam['x-image-suffix'])
    formData.append('x:username', customParam.username)
    formData.append('file', imageBlob, `image.${validExt}`)

    const obsResponse = await this.runtime.fetch(uploadData.host, {
      method: 'POST',
      body: formData,
    })

    const obsRes = await obsResponse.json() as {
      code: number
      data?: { imageUrl: string }
    }

    logger.debug('OBS upload response:', obsRes)

    if (obsRes.code !== 200 || !obsRes.data?.imageUrl) {
      logger.warn('OBS upload failed, using original URL')
      return { url: src }
    }

    return {
      url: obsRes.data.imageUrl,
    }
  }
}
