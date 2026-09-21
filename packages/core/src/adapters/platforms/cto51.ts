/**
 * 51CTO 适配器
 * https://blog.51cto.com
 *
 * 新版图片上传流程:
 * 1. getUploadSign - 获取上传签名
 * 2. getUploadConfig - 获取腾讯云 COS 上传凭证
 * 3. 上传到腾讯云 COS
 */
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cto51')

interface UploadSignResponse {
  code: number
  msg: string
  data: {
    allows: string
    sizeLimit: number
    sizeLimitMessage: string
    url: string
    sign: string
  }
}

interface UploadConfigResponse {
  code: number
  msg: string
  data: {
    url: string
    fields: {
      key: string
      policy: string
      'x-amz-algorithm': string
      'x-amz-signature': string
      'x-amz-credential': string
      'X-Amz-Date': string
    }
  }
}

/**
 * /blogger/draft 与 /blogger/publish 的响应
 * 抓包只拿到了请求体，发布响应结构按 51CTO 常见返回做兼容取值（id / url 多字段兜底）
 */
interface BlogPostResponse {
  status?: number
  code?: number
  msg?: string
  message?: string
  url?: string
  id?: number | string
  data?: {
    did?: number | string
    id?: number | string
    blog_id?: number | string
    blogId?: number | string
    aid?: number | string
    article_id?: number | string
    url?: string
    blogurl?: string
    blog_url?: string
    share_url?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export class Cto51Adapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: '51cto',
    name: '51CTO',
    icon: 'https://blog.51cto.com/favicon.ico',
    homepage: 'https://blog.51cto.com/blogger/publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 51CTO 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private csrf: string | null = null
  private username: string | null = null

  /** 51CTO API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://blog.51cto.com/*',
      headers: {
        Origin: 'https://blog.51cto.com',
        Referer: 'https://blog.51cto.com/blogger/publish',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 检查登录状态
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
        credentials: 'include',
      })
      const html = await response.text()

      // 解析页面获取用户信息
      const imgMatch = html.match(/<li class="more user">\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"/)
      if (!imgMatch) {
        return { isAuthenticated: false, error: '未登录' }
      }

      const userLink = imgMatch[1]
      const avatar = imgMatch[2]
      const uid = userLink.split('/').filter(Boolean).pop() || ''
      this.username = uid

      // 获取 csrf token: 表单里的 _csrf 用的是页面 meta 值，不是 cookie 值
      const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)
      if (csrfMatch) {
        this.csrf = csrfMatch[1]
      }

      return {
        isAuthenticated: true,
        userId: uid,
        username: uid,
        avatar: avatar,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取上传签名
   */
  private async getUploadSign(): Promise<UploadSignResponse['data']> {
    const response = await this.runtime.fetch('https://blog.51cto.com/getUploadSign', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://blog.51cto.com/blogger/publish',
        'Origin': 'https://blog.51cto.com',
      },
      body: 'upload_type=image',
    })

    const res: UploadSignResponse = await response.json()
    if (res.code !== 0) {
      throw new Error(res.msg || '获取上传签名失败')
    }
    return res.data
  }

  /**
   * 获取上传配置 (腾讯云 COS 凭证)
   */
  private async getUploadConfig(
    uploadSign: string,
    ext: string,
    filename: string
  ): Promise<UploadConfigResponse['data']> {
    const response = await this.runtime.fetch('https://blog.51cto.com/getUploadConfig', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        upload_type: 'image',
        upload_sign: uploadSign,
        ext: ext,
        name: filename,
      }).toString(),
    })

    const res: UploadConfigResponse = await response.json()
    if (res.code !== 0) {
      throw new Error(res.msg || '获取上传配置失败')
    }
    return res.data
  }

  /**
   * 上传图片到腾讯云 COS
   */
  private async uploadToCOS(
    cosUrl: string,
    fields: UploadConfigResponse['data']['fields'],
    file: File
  ): Promise<string> {
    const formData = new FormData()

    // 按顺序添加字段 (顺序很重要)
    formData.append('key', fields.key)
    formData.append('policy', fields.policy)
    formData.append('x-amz-algorithm', fields['x-amz-algorithm'])
    formData.append('x-amz-signature', fields['x-amz-signature'])
    formData.append('x-amz-credential', fields['x-amz-credential'])
    formData.append('X-Amz-Date', fields['X-Amz-Date'])
    formData.append('Content-Type', file.type)
    formData.append('file', file)

    const response = await this.runtime.fetch(cosUrl, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`上传到 COS 失败: ${response.status}`)
    }

    // 返回图片 URL (通过 51cto CDN)
    return `https://s2.51cto.com/${fields.key}`
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 确定文件扩展名和 MIME 类型
    const mimeType = blob.type || 'image/jpeg'
    const ext = mimeType.split('/')[1] || 'jpeg'
    const filename = `${Date.now()}.${ext}`
    const file = new File([blob], filename, { type: mimeType })

    // Step 1: 获取上传签名
    const signData = await this.getUploadSign()

    // Step 2: 获取上传配置
    const configData = await this.getUploadConfig(signData.sign, mimeType, filename)

    // Step 3: 上传到腾讯云 COS
    const imageUrl = await this.uploadToCOS(configData.url, configData.fields, file)

    return { url: imageUrl }
  }

  /**
   * 发布文章
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const now = Date.now()
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 确保已获取 csrf
      if (!this.csrf) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('未登录')
        }
      }

      // 优先使用 markdown，处理图片
      const hasMarkdown = !!article.markdown
      let content = article.markdown || article.html || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))

      // 构建请求数据
      // 直发被服务端拒「所属分类不能为空」-> 分类必填；直发还强制标签非空（空 tag 报「标签不能为空」），
      // 格式为逗号分隔文本，草稿不校验。分类 42 与标签内容由用户指定（2026-09-21）
      const tagStr = article.tags && article.tags.length
        ? article.tags.slice(0, 3).join(',')
        : '笔记,经验分享,教程,工具'

      const postData: Record<string, string> = {
        title: article.title,
        content: content,
        pid: '42',
        cate_id: '42',
        custom_id: '0',
        tag: tagStr,
        abstract: '',
        banner_type: '0',
        blog_type: '1',
        copy_code: '1',
        is_hide: '0',
        top_time: '0',
        is_comment: '0',
        is_old: hasMarkdown ? '0' : '2',
        blog_id: '',
        did: '',
        work_id: '',
        class_id: '',
        subjectId: '',
        import_type: '-1',
        invite_code: '',
        raffle: '',
        orig: '',
        _csrf: this.csrf || '',
      }

      const response = await this.runtime.fetch('https://blog.51cto.com/blogger/draft', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        body: new URLSearchParams(postData).toString(),
      })

      const res = await response.json() as BlogPostResponse

      if (res.status !== 1 || !res.data) {
        throw new Error(res.msg || '发布失败')
      }

      const did = String(res.data.did)
      const draftUrl = `https://blog.51cto.com/blogger/draft/${did}`

      if (options?.draftOnly ?? true) {
        return {
          platform: this.meta.id,
          success: true,
          postId: did,
          postUrl: draftUrl,
          draftOnly: true,
          timestamp: now,
        }
      }

      // 线上地址要靠用户名拼，csrf 命中缓存时没走过 checkAuth -> 这里补一次
      if (!this.username) {
        await this.checkAuth()
      }

      // 抓包里点"发布"先做两次机检（全文一次、标签+摘要一次），再带 did + check=1 提交
      await this.checkTxt({ content, title: article.title, tag: postData.tag, abstract: postData.abstract })
      await this.checkTxt({ tag: postData.tag, abstract: postData.abstract })

      const published = await this.publishDraft(postData, did)

      const articleId = this.pickArticleId(published)
      const postUrl = this.pickArticleUrl(published) || this.buildArticleUrl(articleId)

      if (!postUrl) {
        // 发布请求已成功，但响应里既没有线上地址也拼不出地址 -> 回退草稿编辑页
        logger.warn('Publish response has no usable article url, fallback to draft url')
        return {
          platform: this.meta.id,
          success: true,
          postId: articleId || did,
          postUrl: draftUrl,
          draftOnly: false,
          message: '文章已提交发布，但未能从响应中解析到线上地址，postUrl 回退为草稿编辑地址（待实测确认）',
          timestamp: now,
        }
      }

      return {
        platform: this.meta.id,
        success: true,
        postId: articleId || did,
        postUrl,
        draftOnly: false,
        timestamp: now,
      }
    }).catch((error) => ({
      platform: this.meta.id,
      success: false,
      error: (error as Error).message,
      timestamp: now,
    }))
  }

  /**
   * 发布前的内容机检（抓包为两次调用: 全文 + 标签/摘要）
   * 只用于提前发现违规词，失败不阻断发布
   */
  private async checkTxt(fields: Record<string, string>): Promise<void> {
    try {
      const response = await this.runtime.fetch('https://blog.51cto.com/blogger-ajax/check-txt', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        body: new URLSearchParams(fields).toString(),
      })

      const text = await response.text()
      logger.debug('check-txt response:', response.status, text.substring(0, 200))
    } catch (error) {
      logger.warn('check-txt failed, ignored:', (error as Error).message)
    }
  }

  /**
   * 正式发布
   * 抓包: POST /blogger/publish，表单字段与 /blogger/draft 基本一致，
   * 差异是带草稿返回的 did、check=1、import_type 置空
   */
  private async publishDraft(postData: Record<string, string>, did: string): Promise<BlogPostResponse> {
    const response = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      // 分类沿用 postData 的默认值（服务端直发强制要求，实测空值报「所属分类不能为空」）
      body: new URLSearchParams({
        ...postData,
        did,
        import_type: '',
        _csrf: this.csrf || '',
        check: '1',
      }).toString(),
    })

    const responseText = await response.text()
    logger.debug('Publish response:', response.status, responseText.substring(0, 300))

    if (!response.ok) {
      throw new Error(`发布失败: ${response.status} - ${responseText.substring(0, 200)}`)
    }

    let res: BlogPostResponse
    try {
      res = JSON.parse(responseText) as BlogPostResponse
    } catch {
      throw new Error('发布失败: 响应不是有效 JSON，请到博客后台确认是否已发布')
    }

    if (res.status !== 1) {
      throw new Error(res.msg || res.message || '发布失败')
    }

    return res
  }

  /**
   * 从发布响应里取正式文章 ID（草稿 did 与文章 ID 不是同一个值，不能拿来当文章 ID）
   * @returns 解析不到时返回空串
   */
  private pickArticleId(res: BlogPostResponse): string {
    const data = res.data || {}
    const candidates: unknown[] = [data.id, data.blog_id, data.blogId, data.article_id, data.aid, res.id]

    for (const value of candidates) {
      const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : ''
      if (text && text !== '0') {
        return text
      }
    }

    return ''
  }

  /**
   * 从发布响应里直接取线上地址（部分接口会把文章 URL 放在 data.url）
   */
  private pickArticleUrl(res: BlogPostResponse): string {
    const data = res.data || {}
    const candidates: unknown[] = [data.url, data.blogurl, data.blog_url, data.share_url, res.url]

    for (const value of candidates) {
      if (typeof value === 'string' && /^https?:\/\//.test(value)) {
        return value
      }
    }

    return ''
  }

  /**
   * 拼线上文章地址 https://blog.51cto.com/{博客前缀}/{文章ID}
   * 前缀取 checkAuth 从页面导航解析到的用户名（未自定义过博客地址时为 u_{uid}），
   * 该形态抓包未覆盖，属于推断（待实测确认）
   */
  private buildArticleUrl(articleId: string): string {
    if (!articleId) {
      return ''
    }

    const prefix = this.username && !/[/?=&#\s]/.test(this.username) ? this.username : ''
    if (!prefix) {
      return ''
    }

    return `https://blog.51cto.com/${prefix}/${articleId}`
  }
}
