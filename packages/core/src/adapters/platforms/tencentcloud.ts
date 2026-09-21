/**
 * 腾讯云开发者社区 (devpress.csdn.net) 适配器
 *
 * 说明:
 * - 该社区由 CSDN devpress 承载，nsId 标识具体社区，142503 = 腾讯云开发者社区
 * - 接口无签名校验，仅依赖 cookie；本地图片走华为云 OBS 直传后由回调返回图床外链
 * - devpress 没有平台级配置机制，nsId 只能写死
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('TencentCloud')

const SITE = 'https://devpress.csdn.net'

/** 腾讯云开发者社区的 nsId */
const NS_ID = 142503

/** 社区 nsId -> 独立域名，线上文章页为 {domain}/{articleId}.html */
const NS_DOMAINS: Record<number, string> = {
  142503: 'https://tencentcloud.csdn.net',
}

/** 图片上传白名单: MIME -> 扩展名 */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const VALID_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp']

interface DevpressResponse<T> {
  code: number
  msg?: string
  data?: T
}

interface DevpressUser {
  id: number
  username: string
  nickname: string
  ext?: { avatar?: string }
}

interface UploadSignature {
  host: string
  filePath: string
  accessId: string
  policy: string
  signature: string
  callbackUrl: string
  callbackBody: string
  callbackBodyType: string
  customParam: Record<string, string | number>
}

export class TencentCloudAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'tencentcloud',
    name: '腾讯云开发者社区',
    icon: `${SITE}/favicon.ico`,
    homepage: `${SITE}/post/create?nsId=${NS_ID}`,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: devpress 编辑器以 Markdown 为准 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<DevpressResponse<DevpressUser>>(`${SITE}/v1/auth/userInfo`)

      if (res.code === 200 && res.data) {
        return {
          isAuthenticated: true,
          userId: String(res.data.id),
          username: res.data.nickname || res.data.username,
          avatar: res.data.ext?.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting publish...')

      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录腾讯云开发者社区')
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

      const markdown = await this.processImages(article.markdown || '', uploadFn, {
        skipPatterns: ['csdnimg.cn', 'csdn.net'],
        onProgress: options?.onImageProgress,
      })
      const html = await this.processImages(article.html || '', uploadFn)

      const draftOnly = options?.draftOnly ?? true

      // 统一起草 / 发布会用到的基础内容体
      const bodyBase = {
        editorType: 1,
        title: article.title,
        htmlBody: html,
        mdBody: markdown,
        describe: '',
        thumb: '',
        coverImg: '',
        nsId: NS_ID,
        fileInfos: [],
        tags: [],
        openPlatforms: [],
      }

      // 1. 先 save，得到文章 id；草稿标记 -2，直发先标记 0
      const saveRes = await this.postJson<DevpressResponse<{ id: string }>>(
        `${SITE}/v1/article/save`,
        {
          ...bodyBase,
          auditStatus: draftOnly ? -2 : 0,
        }
      )

      logger.debug('Save response:', saveRes)

      if (saveRes.code !== 200 || !saveRes.data?.id) {
        throw new Error(saveRes.msg || (draftOnly ? '保存草稿失败' : '保存文章失败'))
      }

      const postId = saveRes.data.id

      // 2. 直发需要再走 update 一次才能真正上架（抓包：POST /v1/article/update，auditStatus:0）
      if (!draftOnly) {
        const updateRes = await this.postJson<DevpressResponse<{ id: string }>>(
          `${SITE}/v1/article/update`,
          {
            ...bodyBase,
            auditStatus: 0,
            id: postId,
          }
        )

        logger.debug('Update response:', updateRes)

        if (updateRes.code !== 200) {
          throw new Error(updateRes.msg || '发布失败')
        }
      }

      const editUrl = `${SITE}/post/edit/${NS_ID}/${postId}`
      const nsDomain = NS_DOMAINS[NS_ID]

      return this.createResult(true, {
        postId,
        // 直发已上架，返回社区域名下的线上文章页；未知 nsId 回退编辑器地址
        postUrl: !draftOnly && nsDomain ? `${nsDomain}/${postId}.html` : editUrl,
        draftOnly,
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  /**
   * 上传图片到 devpress 图床 (华为云 OBS 直传)
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 下载原图
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 推断扩展名 (data URI 取不到 URL 后缀，只能回退到 MIME)
    const urlExt = src.split('?')[0].split('.').pop()?.toLowerCase() || ''
    const ext = MIME_EXT[imageBlob.type] || (VALID_EXT.includes(urlExt) ? urlExt : 'jpg')

    // 3. 获取直传凭证
    const signRes = await this.get<DevpressResponse<UploadSignature>>(
      `${SITE}/v1/namespace_article/direct/image/uploadNew?image-suffix=${ext}&image-size=${imageBlob.size}`
    )

    if (signRes.code !== 200 || !signRes.data) {
      logger.warn('获取上传凭证失败，保留原图:', src)
      return { url: src }
    }

    const upload = signRes.data

    // 4. 直传 OBS，回调返回图床外链
    const formData = new FormData()
    formData.append('key', upload.filePath)
    formData.append('policy', upload.policy)
    formData.append('AccessKeyId', upload.accessId)
    formData.append('signature', upload.signature)
    formData.append('callbackUrl', upload.callbackUrl)
    formData.append('callbackBody', upload.callbackBody)
    formData.append('callbackBodyType', upload.callbackBodyType)
    for (const [key, value] of Object.entries(upload.customParam)) {
      formData.append(`x:${key}`, String(value))
    }
    formData.append('file', imageBlob, `image.${ext}`)

    const obsResponse = await this.runtime.fetch(upload.host, {
      method: 'POST',
      body: formData,
    })

    const obsRes = await obsResponse.json() as DevpressResponse<{ imageUrl?: string }>

    logger.debug('OBS upload response:', obsRes)

    if (obsRes.code !== 200 || !obsRes.data?.imageUrl) {
      logger.warn('图片上传失败，保留原图:', obsRes.msg)
      return { url: src }
    }

    return { url: obsRes.data.imageUrl }
  }
}
