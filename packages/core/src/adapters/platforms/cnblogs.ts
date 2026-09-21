/**
 * 博客园 (cnblogs.com) 适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cnblogs')

/**
 * 博客园 post 对象（建草稿 / 发布共用同一个结构，来自 i.cnblogs.com 抓包）
 * 只声明适配器会读写的字段，其余键走索引签名
 */
interface CnblogsPost {
  id?: number | null
  postType?: number
  title?: string
  url?: string | null
  postBody?: string
  categoryIds?: Array<number | string> | null
  categories?: unknown
  tags?: string[] | null
  description?: string | null
  autoDesc?: string | null
  datePublished?: string | null
  dateUpdated?: string | null
  isPublished?: boolean
  isDraft?: boolean
  isUpdateDateAdded?: boolean
  isAigc?: boolean
  usingEditorId?: number
  blogId?: number | null
  author?: string | null
  errors?: string[]
  error?: string
  [key: string]: unknown
}

export class CnblogsAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'cnblogs',
    name: '博客园',
    icon: 'https://www.cnblogs.com/favicon.ico',
    homepage: 'https://www.cnblogs.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 博客园使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private xsrfToken: string | null = null
  private blogLogin: string | null = null

  /** 博客园 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://i.cnblogs.com/*',
      headers: {
        'Origin': 'https://i.cnblogs.com',
        'Referer': 'https://i.cnblogs.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://upload.cnblogs.com/*',
      headers: {
        'Origin': 'https://i.cnblogs.com',
        'Referer': 'https://i.cnblogs.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 从 cookie 中获取 XSRF-TOKEN
   */
  private async getXsrfToken(): Promise<string | null> {
    if (this.xsrfToken) {
      return this.xsrfToken
    }

    try {
      // 先访问页面以触发 cookie 设置
      await this.runtime.fetch('https://i.cnblogs.com/posts/edit', {
        method: 'GET',
        credentials: 'include',
      })

      // 使用 cookies API 获取 XSRF-TOKEN
      if (this.runtime.getCookie) {
        logger.debug('Trying to get XSRF-TOKEN via getCookie API...')

        // 尝试不同的域名格式
        const domains = ['i.cnblogs.com', '.cnblogs.com', 'cnblogs.com']
        for (const domain of domains) {
          const value = await this.runtime.getCookie(domain, 'XSRF-TOKEN')
          logger.debug(`getCookie ${domain} result:`, value ? `${value.substring(0, 30)}...` : 'null')
          if (value) {
            this.xsrfToken = value
            logger.debug('Got XSRF-TOKEN from cookies API')
            return this.xsrfToken
          }
        }
      } else {
        logger.warn('getCookie API not available')
      }

      logger.warn('Could not find XSRF-TOKEN')
      return null
    } catch (error) {
      logger.error('Failed to get XSRF-TOKEN:', error)
      return null
    }
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://home.cnblogs.com/user/CurrentUserInfo', {
        method: 'GET',
        credentials: 'include',
      })

      const text = await response.text()

      // 解析 HTML 响应获取用户信息
      // 页面结构: <a href="/u/xxx/"><img class="pfs" src="..."></a>
      const avatarMatch = text.match(/<img[^>]+class="pfs"[^>]+src="([^"]+)"/)
      const linkMatch = text.match(/href="\/u\/([^/]+)\/"/)

      if (!linkMatch) {
        return { isAuthenticated: false }
      }

      const uid = linkMatch[1]
      const avatar = avatarMatch ? avatarMatch[1] : undefined
      this.blogLogin = uid

      return {
        isAuthenticated: true,
        userId: uid,
        username: uid,
        avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to cnblogs...')

      // 1. Get XSRF-TOKEN
      const xsrfToken = await this.getXsrfToken()
      logger.info('XSRF-TOKEN:', xsrfToken ? `${xsrfToken.substring(0, 20)}...` : 'null')
      if (!xsrfToken) {
        throw new Error('获取 XSRF-TOKEN 失败，请刷新页面后重试')
      }

      // 保存 xsrfToken 供 uploadImageByUrl 使用
      this.xsrfToken = xsrfToken

      // 2. 处理图片上传
      let markdown = article.markdown || ''
      logger.debug('Markdown before processImages:', markdown.substring(0, 200))

      markdown = await this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['cnblogs.com', 'img2024.cnblogs.com', 'img2023.cnblogs.com'],
          onProgress: options?.onImageProgress,
        }
      )

      logger.debug('Markdown after processImages:', markdown.substring(0, 200))

      logger.debug('Markdown content length:', markdown.length)

      // 3. 创建草稿（抓包确认: 博客园没有独立发布接口，发布与草稿走同一个 POST /api/posts）
      const draftBody: CnblogsPost = {
        id: null,
        postType: 2, // 2 = 文章, 1 = 随笔
        accessPermission: 0,
        title: article.title,
        url: null,
        postBody: markdown,
        categoryIds: null,
        categories: null,
        collectionIds: [],
        inSiteCandidate: false,
        inSiteHome: false,
        siteCategoryId: null,
        blogTeamIds: null,
        isPublished: false,
        displayOnHomePage: false,
        isAllowComments: true,
        includeInMainSyndication: false,
        isPinned: false,
        showBodyWhenPinned: false,
        isOnlyForRegisterUser: false,
        isUpdateDateAdded: false,
        entryName: null,
        description: null,
        featuredImage: null,
        tags: null,
        password: null,
        publishAt: null,
        datePublished: new Date().toISOString(),
        dateUpdated: null,
        isMarkdown: true,
        isDraft: true,
        autoDesc: null,
        changePostType: false,
        blogId: 0,
        author: null,
        removeScript: false,
        clientInfo: null,
        changeCreatedTime: false,
        canChangeCreatedTime: false,
        isContributeToImpressiveBugActivity: false,
        usingEditorId: 5,
        sourceUrl: null,
      }

      const created = await this.submitPost(draftBody, xsrfToken, '创建草稿')

      if (!created.id) {
        throw new Error('创建草稿失败: 无效响应')
      }

      const postId = String(created.id)
      const draftUrl = `https://i.cnblogs.com/articles/edit;postId=${postId}`

      logger.debug('Draft created:', postId)

      if (options?.draftOnly ?? true) {
        return this.createResult(true, {
          postId,
          postUrl: draftUrl,
          draftOnly: true,
        })
      }

      // 4. 直发：按编辑器行为先写一次快照，再把完整 post 对象以 isPublished:true 提交回去
      await this.saveSnapshot(Number(postId), article.title, markdown, xsrfToken)

      const publishBody = await this.buildPublishBody(draftBody, created, article.title, markdown)
      const published = await this.submitPost(publishBody, xsrfToken, '发布')

      const publishedUrl = typeof published.url === 'string' && published.url
        ? published.url
        : (typeof publishBody.url === 'string' && publishBody.url ? publishBody.url : draftUrl)

      logger.info('Published:', publishedUrl)

      return this.createResult(true, {
        postId,
        postUrl: publishedUrl,
        draftOnly: false,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * POST https://i.cnblogs.com/api/posts
   * 建草稿与发布共用：body.id 为空即新建草稿，body.isPublished=true 即正式发布
   */
  private async submitPost(
    body: CnblogsPost,
    xsrfToken: string,
    action: string
  ): Promise<CnblogsPost> {
    const response = await this.runtime.fetch('https://i.cnblogs.com/api/posts', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-xsrf-token': xsrfToken,
      },
      body: JSON.stringify(body),
    })

    const responseText = await response.text()
    logger.debug(`${action} response:`, response.status, responseText.substring(0, 300))

    if (!response.ok) {
      // 检查是否是认证错误
      if (response.status === 401 || response.status === 403) {
        throw new Error('未登录或登录已过期，请重新登录博客园')
      }
      throw new Error(`${action}失败: ${response.status} - ${responseText}`)
    }

    let data: CnblogsPost
    try {
      data = JSON.parse(responseText) as CnblogsPost
    } catch {
      throw new Error(`${action}失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }

    if (data.errors?.length) {
      throw new Error(`${action}失败: ${data.errors.join('; ')}`)
    }

    if (data.error) {
      throw new Error(`${action}失败: ${data.error}`)
    }

    return data
  }

  /**
   * 组装发布用的 post 对象（抓包里它就是编辑器内存里的完整 post）
   * 字段优先取建草稿响应；响应没有 blogId/author/url 时补一次 GET /api/posts/{id}，
   * 仍拿不到就退回建草稿时服务端已接受过的取值（blogId:0 / author:null / url:null）
   */
  private async buildPublishBody(
    draftBody: CnblogsPost,
    created: CnblogsPost,
    title: string,
    markdown: string
  ): Promise<CnblogsPost> {
    const postId = Number(created.id)
    const post: CnblogsPost = { ...draftBody, ...created }

    if (!post.blogId || !post.author || !post.url) {
      const detail = await this.fetchPostDetail(postId)
      if (detail) {
        Object.assign(post, detail)
      }
    }

    if (!post.url) {
      const login = await this.getBlogLogin()
      if (login) {
        post.url = `https://www.cnblogs.com/${login}/articles/${postId}`
      }
    }

    const now = new Date().toISOString()

    post.id = postId
    post.title = title
    post.postBody = markdown
    post.isPublished = true
    post.isDraft = true
    post.isUpdateDateAdded = true
    post.tags = Array.isArray(post.tags) ? post.tags : []
    post.categoryIds = Array.isArray(post.categoryIds) ? post.categoryIds : []
    post.description = post.description ?? ''
    post.datePublished = post.datePublished || now
    post.dateUpdated = post.dateUpdated || now
    post.isAigc = post.isAigc ?? false
    post.usingEditorId = post.usingEditorId ?? 5
    post.blogId = post.blogId ?? 0
    post.author = post.author ?? null

    return post
  }

  /**
   * 写编辑器快照（抓包里点发布前的最后一步自动保存）
   * 只是编辑器留档，失败不阻断发布
   */
  private async saveSnapshot(
    postId: number,
    title: string,
    content: string,
    xsrfToken: string
  ): Promise<void> {
    try {
      const response = await this.runtime.fetch('https://i.cnblogs.com/api/snapshots', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-xsrf-token': xsrfToken,
        },
        body: JSON.stringify({
          id: 0,
          content,
          contentId: postId,
          title,
          type: 4,
          format: 'md',
          updateTime: new Date().toISOString(),
          editorId: 5,
        }),
      })

      if (!response.ok) {
        logger.warn(`保存快照失败: ${response.status}`)
      }
    } catch (error) {
      logger.warn('保存快照失败:', (error as Error).message)
    }
  }

  /**
   * GET /api/posts/{id} 取服务端保存的完整 post
   * @returns post 对象；请求失败或响应结构不认识时返回 null
   */
  private async fetchPostDetail(postId: number): Promise<CnblogsPost | null> {
    try {
      const response = await this.runtime.fetch(`https://i.cnblogs.com/api/posts/${postId}`, {
        method: 'GET',
        credentials: 'include',
      })

      if (!response.ok) {
        logger.debug('Fetch post detail skipped:', response.status)
        return null
      }

      const raw = await response.json() as Record<string, unknown>
      const nested = raw.post && typeof raw.post === 'object' ? raw.post as CnblogsPost : null
      return nested || (raw as CnblogsPost)
    } catch (error) {
      logger.debug('Fetch post detail failed:', error)
      return null
    }
  }

  /**
   * 博客登录名（/u/{login}），用于拼线上文章地址 https://www.cnblogs.com/{login}/articles/{id}
   */
  private async getBlogLogin(): Promise<string | null> {
    if (this.blogLogin) {
      return this.blogLogin
    }

    const auth = await this.checkAuth()
    return auth.username || null
  }

  /**
   * 上传图片到博客园
   * 使用新版 CORS 上传接口
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.xsrfToken) {
      throw new Error('XSRF-TOKEN 未获取')
    }

    // 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    formData.append('image', imageBlob, 'image.png')
    formData.append('app', 'blog')
    formData.append('uploadType', 'Select')

    // 上传图片
    const uploadResponse = await this.runtime.fetch(
      'https://upload.cnblogs.com/v2/images/cors-upload',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-xsrf-token': this.xsrfToken,
        },
        body: formData,
      }
    )

    const responseText = await uploadResponse.text()
    logger.debug('Image upload raw response:', responseText)

    if (!uploadResponse.ok) {
      throw new Error(`图片上传失败: ${uploadResponse.status} - ${responseText}`)
    }

    let res: Record<string, unknown>
    try {
      res = JSON.parse(responseText)
    } catch {
      throw new Error(`图片上传失败: 响应不是 JSON - ${responseText.substring(0, 100)}`)
    }

    logger.debug('Image upload parsed response:', JSON.stringify(res))

    // 尝试不同的响应格式
    const imageUrl = res.data || res.url || res.imageUrl || res.src
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new Error(`图片上传失败: 无法获取图片 URL - ${JSON.stringify(res)}`)
    }

    logger.info('Image uploaded:', imageUrl)
    return {
      url: imageUrl,
    }
  }
}
