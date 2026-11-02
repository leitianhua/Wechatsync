/**
 * 掘金适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { signAWS4, crc32 } from '../../lib'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Juejin')

// ImageX 服务常量
const IMAGEX_AID = '2608'
const IMAGEX_SERVICE_ID = '73owjymdk6'

// content_api 公共参数（抓包: /content_api/v1/article/publish?aid=2608&uuid=<web_id>）
const CONTENT_API_AID = '2608'

// 掘金埋点 Cookie，里面存着前端 web_id（即 API 公共参数 uuid）
const TEA_COOKIE_NAME = '__tea_cookie_tokens_2608'

// 生成 UUID (用于 ImageX API)
function generateUUID(): string {
  return 'xxxxxxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  ) + Date.now().toString()
}

// ImageX Token 响应类型
interface ImageXTokenResponse {
  data?: {
    token: {
      AccessKeyId: string
      SecretAccessKey: string
      SessionToken: string
      ExpiredTime: string  // ISO 日期字符串 "2026-01-14T00:15:24+08:00"
      CurrentTime: string
    }
  }
  err_no?: number
  err_msg?: string
}

// 解析后的 Token
interface ImageXToken {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  ExpiredTime: number  // Unix 时间戳（毫秒）
}

// ImageX ApplyUpload 响应类型
interface ImageXApplyUploadResponse {
  ResponseMetadata: {
    RequestId: string
    Action: string
    Version: string
    Service: string
    Region: string
  }
  Result: {
    RequestId: string
    UploadAddress: {
      StoreInfos: Array<{
        StoreUri: string
        Auth: string
        UploadID: string
      }>
      UploadHosts: string[]
      SessionKey: string
    }
  }
}

// ImageX CommitUpload 响应类型
interface ImageXCommitUploadResponse {
  ResponseMetadata: {
    RequestId: string
    Action: string
    Version: string
    Service: string
    Region: string
  }
  Result: {
    RequestId: string
    Results: Array<{
      Uri: string
      UriStatus: number
    }>
    PluginResult: Array<{
      FileName: string
      ImageUri: string
      ImageWidth: number
      ImageHeight: number
      ImageMd5: string
      ImageFormat: string
      ImageSize: number
    }>
  }
}

// 文章发布响应类型（err_no=0 时 data.article_id 为新文章 ID）
interface ArticlePublishResponse {
  data?: {
    article_id?: string | number
    id?: string | number
  }
  err_no?: number
  err_msg?: string
}

// 编辑器 autoSaveDraft 抓包的正文图片对照项：签名 URL -> 裸 StoreUri
interface JuejinPic {
  pic_url: string
  pic_uri: string
}

// 正文摘要（brief_content）生成规则，实测逐字节复刻编辑器 autoSaveDraft 抓包：
// 去图片、链接留文字、去标题井号、连续空白折叠为单空格、截前 100 字符。
// 实测该字段为空串时 article/publish 直接报「参数错误」（与 UI 成功发布草稿 diff 出的唯一实质差异）
export function buildJuejinBrief(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

export class JuejinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'juejin',
    name: '掘金',
    icon: 'https://lf-web-assets.juejin.cn/obj/juejin-web/xitu_juejin_web/static/favicons/favicon-32x32.png',
    homepage: 'https://juejin.cn',
    capabilities: ['article', 'draft', 'image_upload', 'categories', 'tags', 'cover'],
  }

  /** 预处理配置: 掘金使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private cachedCsrfToken: string | null = null
  private cachedImageXToken: ImageXToken | null = null
  private imageXTokenExpiry: number = 0
  private imageXTokenPromise: Promise<ImageXToken> | null = null
  private uuid: string = generateUUID()

  /** 掘金 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://api.juejin.cn/*',
      headers: {
        'Origin': 'https://juejin.cn',
        'Referer': 'https://juejin.cn/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imagex.bytedanceapi.com/*',
      headers: {
        'Origin': 'https://juejin.cn',
        'Referer': 'https://juejin.cn/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://api.juejin.cn/user_api/v1/user/get', {
        method: 'GET',
        credentials: 'include',
      })

      const data = await response.json() as {
        data?: {
          user_id?: string
          user_name?: string
          avatar_large?: string
        }
      }

      if (data.data?.user_id) {
        return {
          isAuthenticated: true,
          userId: data.data.user_id,
          username: data.data.user_name,
          avatar: data.data.avatar_large,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 CSRF Token (参考 DSL juejin.transform.ts)
   */
  private async getCsrfToken(): Promise<string> {
    if (this.cachedCsrfToken) {
      return this.cachedCsrfToken
    }

    // 使用 runtime.fetch 以便 extension 能正确处理
    const response = await this.runtime.fetch('https://api.juejin.cn/user_api/v1/sys/token', {
      method: 'HEAD',
      headers: {
        'x-secsdk-csrf-request': '1',
        'x-secsdk-csrf-version': '1.2.10',
      },
      credentials: 'include',
    })

    const wareToken = response.headers.get('x-ware-csrf-token')
    if (!wareToken) {
      logger.warn('CSRF token not found in response headers')
      throw new Error('Failed to get CSRF token')
    }

    // Token 格式: "0,{actual_token},86370000,success,{session_id}"
    const parts = wareToken.split(',')
    if (parts.length < 2) {
      throw new Error('Invalid CSRF token format')
    }

    this.cachedCsrfToken = parts[1]
    logger.debug('Got CSRF token:', this.cachedCsrfToken.substring(0, 10) + '...')
    return this.cachedCsrfToken
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 获取 CSRF token
      let csrfToken = await this.withTimeout('CSRF', 15000, () => this.getCsrfToken())

      // 2. 使用预处理好的 markdown（Content Script 已转换）
      // 掘金使用 Markdown 格式
      let markdown = article.markdown || ''

      // 3. 处理图片（上传到掘金图床）
      // 单图 30s 超时：一张图卡住就跳过该图，不拖垮整步；整步预算 300s（15~16 张图的正常耗时约 30s）
      // 3 路并发：掘金每张图要走 token→apply→TOS→commit，串行时 15 张图能吃掉两分钟
      markdown = await this.withTimeout('图片转存', 300000, () => this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: [
            'juejin.cn', 'p1-juejin', 'p3-juejin',
            'p6-juejin', 'p9-juejin', 'byteimg.com'
          ],
          onProgress: options?.onImageProgress,
          perImageTimeout: 30000,
          concurrency: 3,
        }
      ))

      // 上传封面图(如有),只将新的平台图床 URL 写入草稿
      let coverImage = ''
      if (article.cover) {
        try {
          logger.info('Uploading cover image...')
          const coverRes = await this.withTimeout('封面上传', 30000, () => this.uploadImageByUrl(article.cover!))
          if (coverRes.url && coverRes.url !== article.cover && !coverRes.url.startsWith('data:')) {
            coverImage = coverRes.url
            logger.debug('Cover uploaded:', coverImage)
          } else {
            logger.warn('Cover upload did not produce a usable platform URL, skipping cover')
          }
        } catch (err) {
          logger.warn('Cover upload failed, skipping cover:', (err as Error).message)
        }
      }

      // 5. 编辑器 autoSaveDraft 实测的最后一步转换：图床图片签名长 URL 换成裸 StoreUri，
      //    签名 URL 记进 pics（与编辑器行为对齐；服务端读取草稿时会再签回长 URL）
      const { content: storedMarkdown, pics } = this.transformPicsToStoreUri(markdown)
      // brief_content 必须非空，否则 article/publish 报「参数错误」（见 buildJuejinBrief 注释）
      const briefContent = buildJuejinBrief(storedMarkdown)

      // 6. 创建草稿 (参数来自 DSL juejin.yaml + juejin.transform.ts prepareBody)
      // category_id 传 '0' 时直发被服务端拒「至少添加一个分类」，固定用真实分类「开发工具」
      // 实测 create 带非空 tag_ids 会被拒「参数错误」，编辑器真实流程是 create 空标签
      // -> update 才写 tag_ids，所以标签在这一步留空，建完草稿后用 updateDraftTags 补写
      const tagIds = await this.resolveTagIds(article.tags)

      const createDraft = () => this.withTimeout('创建草稿', 30000, () => this.runtime.fetch(
        'https://api.juejin.cn/content_api/v1/article_draft/create',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-secsdk-csrf-token': csrfToken,
          },
          body: JSON.stringify({
            brief_content: briefContent,
            category_id: '6809637771511070734',
            cover_image: coverImage,
            edit_type: 10,
            html_content: 'deprecated',
            link_url: '',
            mark_content: storedMarkdown,
            tag_ids: [],
            title: article.title,
          }),
        }
      ))

      // 掘金风控对连发请求会返回 403 空响应（无业务错误码可读），实测是瞬时拦截、重试即过
      // （10-07 #2397、10-04 #11044 等；历史 4 例隔几分钟重发全部成功），
      // 所以这里刷新 CSRF token 后原样重试最多 2 次，避免整篇发布被瞬时风控打掉
      let createResponse = await createDraft()
      let responseText = await createResponse.text()
      for (let retry = 1; retry <= 2 && createResponse.status === 403; retry++) {
        logger.warn(`Create draft 403, retry ${retry}/2 with fresh CSRF token:`, responseText.substring(0, 100))
        this.cachedCsrfToken = null
        csrfToken = await this.withTimeout('CSRF', 15000, () => this.getCsrfToken())
        await new Promise((resolve) => setTimeout(resolve, 3000))
        createResponse = await createDraft()
        responseText = await createResponse.text()
      }

      // 检查响应状态和内容
      logger.debug('Create draft response:', createResponse.status, responseText.substring(0, 300))

      if (!createResponse.ok) {
        throw new Error(`创建草稿失败: ${createResponse.status} - ${responseText}`)
      }

      let createData: { data?: { id?: string }; err_msg?: string; err_no?: number }
      try {
        createData = JSON.parse(responseText)
      } catch {
        throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
      }

      // 检查业务错误
      if (createData.err_no && createData.err_no !== 0) {
        throw new Error(`[创建草稿] ${createData.err_msg || `错误码 ${createData.err_no}`}`)
      }

      if (!createData.data?.id) {
        throw new Error(createData.err_msg || '创建草稿失败: 无效响应')
      }

      const draftId = createData.data.id
      logger.debug('Draft created:', draftId)

      const draftUrl = `https://juejin.cn/editor/drafts/${draftId}`

      // 7. 编辑器实测：tag_ids 只能通过 update 绑定（create 带非空标签被拒「参数错误」）
      await this.updateDraftTags(draftId, article.title, storedMarkdown, coverImage, briefContent, tagIds, pics, csrfToken)

      // draftOnly（默认）时行为与之前完全一致：只建草稿
      if (options?.draftOnly ?? true) {
        return this.createResult(true, {
          postId: draftId,
          postUrl: draftUrl,
          draftOnly: true,
        })
      }

      // 8. 正式发布（建草稿成功后调用真实"点发布"接口）
      // 字数必须按「转换后落库的内容」估算，与服务端重算口径一致
      const articleId = await this.publishDraft(draftId, this.estimateOriginWordCount(storedMarkdown), csrfToken)

      if (!articleId) {
        // 发布请求已成功，但解析不到文章 ID -> 回退编辑器地址（待实测真实链接格式）
        logger.warn('Publish succeeded but article id missing, fallback to editor url')
        return this.createResult(true, {
          postId: draftId,
          postUrl: draftUrl,
          draftOnly: false,
          message: '发布请求已提交，但未能从响应中解析到文章 ID，postUrl 回退为编辑器草稿地址',
        })
      }

      logger.info('Published article:', articleId)

      return this.createResult(true, {
        postId: articleId,
        postUrl: `https://juejin.cn/post/${articleId}`,
        draftOnly: false,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 正式发布草稿
   * 请求来自真实抓包: POST /content_api/v1/article/publish?aid=2608&uuid=<web_id>
   * @param draftId 草稿 ID（article_draft/create 返回的 data.id）
   * @param originWordCount 正文明文字数（近似值）
   * @param csrfToken 已获取的 x-secsdk-csrf-token
   * @returns 文章 ID；响应里解析不到时返回 null，由调用方回退
   */
  private async publishDraft(
    draftId: string,
    originWordCount: number,
    csrfToken: string
  ): Promise<string | null> {
    const uuid = await this.getWebId()
    const url = `https://api.juejin.cn/content_api/v1/article/publish?aid=${CONTENT_API_AID}&uuid=${uuid}`

    const response = await this.withTimeout('正式发布', 30000, () => this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-secsdk-csrf-token': csrfToken,
      },
      // 编辑器实测: encrypted_word_count 必填，值 = (origin_word_count ^ 538942) + 538942
      // （掘金 app bundle 里 maskCount 公式）。服务端不严格核对字数与正文（UI 实测发 502、
      // 真实 worker 重算 537 仍发布成功），但加密值必须和 origin_word_count 自洽
      body: JSON.stringify({
        draft_id: draftId,
        sync_to_org: false,
        column_ids: [],
        theme_ids: [],
        origin_word_count: originWordCount,
        encrypted_word_count: (originWordCount ^ 538942) + 538942,
      }),
    }))

    const responseText = await response.text()
    logger.debug('Publish response:', response.status, responseText.substring(0, 300))

    if (!response.ok) {
      throw new Error(`发布失败: ${response.status} - ${responseText}`)
    }

    let publishData: ArticlePublishResponse
    try {
      publishData = JSON.parse(responseText)
    } catch {
      throw new Error(`发布失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }

    // 检查业务错误
    if (publishData.err_no && publishData.err_no !== 0) {
      throw new Error(`[正式发布] ${publishData.err_msg || `错误码 ${publishData.err_no}`}`)
    }

    const articleId = publishData.data?.article_id || publishData.data?.id
    if (!articleId) {
      return null
    }

    return String(articleId)
  }

  /**
   * 给草稿补写分类+标签
   * 请求体逐字段照抄编辑器实测抓包: POST /content_api/v1/article_draft/update
   * @param draftId 草稿 ID
   * @param title 文章标题
   * @param markdown 正文（Markdown，已经过 transformPicsToStoreUri 转换）
   * @param coverImage 已上传到平台图床的封面 URL，可空
   * @param briefContent 正文摘要（见 buildJuejinBrief，发布校验要求非空）
   * @param tagIds 站内标签 ID 数组（见 resolveTagIds）
   * @param pics 正文图片裸 StoreUri 与签名 URL 对照表（见 transformPicsToStoreUri）
   * @param csrfToken 已获取的 x-secsdk-csrf-token
   */
  private async updateDraftTags(
    draftId: string,
    title: string,
    markdown: string,
    coverImage: string,
    briefContent: string,
    tagIds: string[],
    pics: JuejinPic[],
    csrfToken: string
  ): Promise<void> {
    const uuid = await this.getWebId()
    const response = await this.withTimeout('补写标签', 30000, () => this.runtime.fetch(
      `https://api.juejin.cn/content_api/v1/article_draft/update?aid=${CONTENT_API_AID}&uuid=${uuid}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-secsdk-csrf-token': csrfToken,
        },
        // is_gfw/is_english/is_original + pics 为编辑器 autoSaveDraft 实测抓包字段，与编辑器落库状态对齐
        body: JSON.stringify({
          id: draftId,
          category_id: '6809637771511070734',
          tag_ids: tagIds,
          link_url: '',
          cover_image: coverImage,
          title,
          brief_content: briefContent,
          edit_type: 10,
          html_content: 'deprecated',
          mark_content: markdown,
          theme_ids: [],
          pics,
          is_gfw: 0,
          is_english: 0,
          is_original: 1,
        }),
      }
    ))

    const responseText = await response.text()
    logger.debug('Update draft (tags) response:', response.status, responseText.substring(0, 200))

    if (!response.ok) {
      throw new Error(`草稿补写标签失败: ${response.status} - ${responseText}`)
    }

    let data: { err_no?: number; err_msg?: string }
    try {
      data = JSON.parse(responseText)
    } catch {
      throw new Error(`草稿补写标签失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }
    if (data.err_no && data.err_no !== 0) {
      throw new Error(`[补写标签] ${data.err_msg || `错误码 ${data.err_no}`}`)
    }
  }

  /**
   * 照抄编辑器 autoSaveDraft 前的最后一步转换（实测抓包 cap4.json）：
   * 把 ImageX 图床的签名长 URL 图片 `![](<https://...tos-cn-i-73owjymdk6/<id>~tplv...>))`
   * 换成裸 StoreUri `![](tos-cn-i-73owjymdk6/<id>)`，同时收集 {pic_url, pic_uri} 供 update 的 pics 字段。
   * 服务端以转换后落库内容重算字数，跳过这一步会让 article/publish 永远「参数错误」。
   */
  private transformPicsToStoreUri(markdown: string): { content: string; pics: JuejinPic[] } {
    const pics: JuejinPic[] = []
    const content = markdown.replace(
      /!\[[^\]]*\]\((https?:\/\/[^)\s]*?tos-cn-i-73owjymdk6\/([A-Za-z0-9]+)[^)\s]*)\)/g,
      (_match, url: string, id: string) => {
        const picUri = `tos-cn-i-73owjymdk6/${id}`
        pics.push({ pic_url: url, pic_uri: picUri })
        return `![](${picUri})`
      }
    )
    if (pics.length) {
      logger.debug('Transformed image store uris:', pics.length)
    }
    return { content, pics }
  }

  /**
   * 获取前端埋点 web_id（掘金 API 公共参数 uuid）
   * 抓包值 7534710285519013426 来自埋点 Cookie，跟 ImageX 用的随机 this.uuid 不是一个来源
   * @returns web_id；取不到时返回空串（待实测服务端是否强校验 uuid）
   */
  private async getWebId(): Promise<string> {
    if (!this.runtime.getCookie) {
      logger.warn('runtime.getCookie unavailable, publish uuid will be empty')
      return ''
    }

    try {
      // Cookie 值是双重 URL 编码的 JSON: %257B%2522web_id%2522%253A...
      // getCookie RPC 曾出现无响应挂死，uuid 服务端不强校验，8 秒拿不到就按空串走后续流程
      let raw = (await this.withTimeout('读web_id_cookie', 8000, () => this.runtime.getCookie!('.juejin.cn', TEA_COOKIE_NAME))
        .catch(() => {
          logger.warn('getCookie web_id timed out, uuid will be empty')
          return null
        })) || ''
      for (let i = 0; i < 2 && raw && !raw.trim().startsWith('{'); i++) {
        try {
          const decoded = decodeURIComponent(raw)
          if (decoded === raw) break  // 已无编码可解
          raw = decoded
        } catch {
          break  // 编码异常时保留原值，交给下面的正则兜底
        }
      }

      if (raw) {
        try {
          const tea = JSON.parse(raw) as { web_id?: string; user_unique_id?: string }
          const webId = tea.web_id || tea.user_unique_id || ''
          if (webId) {
            logger.debug('Got web_id:', webId)
            return webId
          }
        } catch {
          // JSON 解析失败，交给下面的正则兜底
        }

        // 兜底: 编码值里的 %2522 等片段带数字，锚定正则会失配，所以退而取长数字串（web_id 是 19 位雪花 ID）
        const fallback = raw.match(/web_id\D+(\d{6,})/)?.[1] || raw.match(/\d{15,}/)?.[0] || ''
        if (fallback) {
          logger.debug('Got web_id by regex:', fallback)
          return fallback
        }
      }

      logger.warn('web_id not found in juejin tea cookie, publish uuid will be empty')
    } catch (error) {
      logger.warn('Failed to read web_id cookie:', (error as Error).message)
    }

    return ''
  }

  /**
   * 给可能无响应挂死的 await（runtime.fetch/getCookie 等 RPC）包一层带环节名的超时，
   * 保证 syncArticle 永远能在 CLI 360s 超时前带明确原因返回，而不是整条链路静默悬挂
   */
  private withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[${label}] 步骤超时 ${Math.round(ms / 1000)}s（RPC/网络无响应）`)),
        ms
      )
      fn().then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) }
      )
    })
  }

  /**
   * 把标签名解析为站内已有 tag_id（掘金直发强制「至少添加一个标签」，且不认识新标签）
   * 接口来自编辑器标签搜索抓包: POST /tag_api/v1/query_tag_list
   * 匹配不到时兜底用「笔记」（实测存在），与 CSDN/51CTO 的固定标签口径保持一致
   */
  private async resolveTagIds(names: string[] | undefined): Promise<string[]> {
    const FALLBACK_TAG_ID = '6809641211075231751' // 「笔记」
    const wanted = (names && names.length ? names : []).slice(0, 3)
    const ids: string[] = []

    for (const name of wanted) {
      try {
        const tagId = await this.searchTagId(name.trim())
        if (tagId && !ids.includes(tagId)) ids.push(tagId)
      } catch (error) {
        logger.warn(`Tag lookup failed for "${name}":`, (error as Error).message)
      }
    }

    if (!ids.length) {
      logger.warn('No tag resolved from', wanted, '-> fallback to 笔记')
      return [FALLBACK_TAG_ID]
    }
    logger.debug('Resolved tag_ids:', ids)
    return ids
  }

  /**
   * 单个标签名查 tag_id：优先大小写不敏感的全匹配，否则取第一条结果
   */
  private async searchTagId(keyword: string): Promise<string | null> {
    if (!keyword) return null
    const uuid = await this.getWebId()
    const url = `https://api.juejin.cn/tag_api/v1/query_tag_list?aid=${CONTENT_API_AID}&uuid=${uuid}`

    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cursor: '0', key_word: keyword, limit: 10, sort_type: 1 }),
    })

    if (!response.ok) {
      throw new Error(`query_tag_list HTTP ${response.status}`)
    }

    const data = await response.json() as {
      data?: Array<{ tag_id?: string; tag?: { tag_name?: string } }>
      err_no?: number
    }
    if (data.err_no && data.err_no !== 0) {
      throw new Error(`query_tag_list err_no=${data.err_no}`)
    }

    const list = data.data || []
    const exact = list.find(t => (t.tag?.tag_name || '').toLowerCase() === keyword.toLowerCase())
    const hit = exact || list[0]
    if (!hit?.tag_id) {
      logger.warn(`No站内 tag found for "${keyword}"`)
      return null
    }
    return String(hit.tag_id)
  }

  /**
   * 估算正文原始字数（对应抓包里的 origin_word_count）
   * 移植自掘金编辑器字数统计 worker: xitu_juejin_web_editor/js/count.*.worker.js
   * 服务端不严格核对字数与正文内容（UI 实测 502 vs 真实 worker 537 仍通过），报个合理值即可
   */
  private estimateOriginWordCount(markdown: string): number {
    if (!markdown) return 0
    let src = markdown
    src = src.replace(/```mermaid[^]*?```?/gs, '')      // mermaid 图
    src = src.replace(/\$[\s\S]+?\$\$|\$[\s\S]+?\$/g, '') // 公式
    src = src.replace(/.*---\ntheme:.*?\n---/gs, '')    // 主题头
    src = src.replace(/.*---\nhighlight:.*?\n---/gs, '') // 高亮头
    src = src.replace(/<link\S+?<\/link>/gs, '')
    src = src.replace(/<style\S+?<\/style>/gs, '')
    src = src.replace(/<script\S+?<\/script>/gs, '')
    src = src.replace(/<\S\s+?>/gs, '\n')               // 带属性的单标签转行
    src = src.replace(/\s{2,}/gs, '\n')                 // 连续空白折叠
    src = src.replace(/!\[.*\]\(http.*?\)/g, '')        // 外链图片
    src = src.replace(/((http|https):\/\/)?[\w\-_]+(\.[\w\-_]+)+([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])?/gs, '') // URL
    src = src.replace(/<[^>\n\u4e00-\u9fff]*>/g, '')    // 残留 HTML 标签
    src = src.trim()

    const reg = new RegExp('[\u4e00-\u9fbf\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff]|[a-zA-Z]+|\\d', 'g')
    const matches = src.match(reg)
    return matches ? matches.length : 0
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   * 需要设置动态请求头规则以支持 MCP 调用
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, () => this.uploadImageBinaryInternal(file))
  }

  /**
   * 通过 URL 上传图片
   * 支持远程 URL 和 data URI，都使用 ImageX 流程
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      let blob: Blob

      if (src.startsWith('data:')) {
        // data URI 直接转 blob
        logger.debug('Detected data URI, converting to blob')
        blob = await fetch(src).then(r => r.blob())
      } else {
        // 远程 URL：先下载再上传
        logger.debug('Downloading remote image:', src.substring(0, 80))
        const response = await this.runtime.fetch(src, {
          method: 'GET',
        })

        if (!response.ok) {
          logger.warn('Failed to download image:', response.status)
          return { url: src }
        }

        blob = await response.blob()
      }

      // 使用 ImageX 流程上传
      const url = await this.uploadImageBinaryInternal(blob)
      logger.debug('Uploaded image:', src.substring(0, 50), '->', url)
      return { url }
    } catch (error) {
      logger.warn('Failed to upload image by URL:', src, error)
      return { url: src } // 失败时返回原 URL
    }
  }

  /**
   * 获取 ImageX 上传凭证
   */
  private async getImageXToken(): Promise<ImageXToken> {
    // 检查缓存是否有效（提前 60 秒过期）
    if (this.cachedImageXToken && Date.now() < this.imageXTokenExpiry - 60000) {
      return this.cachedImageXToken
    }

    // 并发转图时多个 worker 会同时来取，共享同一次请求
    if (!this.imageXTokenPromise) {
      this.imageXTokenPromise = this.fetchImageXToken().finally(() => {
        this.imageXTokenPromise = null
      })
    }
    return this.imageXTokenPromise
  }

  private async fetchImageXToken(): Promise<ImageXToken> {
    const url = `https://api.juejin.cn/imagex/v2/gen_token?aid=${IMAGEX_AID}&uuid=${this.uuid}&client=web`
    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const responseText = await response.text()
    logger.debug('gen_token response:', responseText.substring(0, 500))

    let data: ImageXTokenResponse
    try {
      data = JSON.parse(responseText)
    } catch {
      throw new Error(`Invalid JSON response from gen_token: ${responseText.substring(0, 200)}`)
    }

    if (data.err_no && data.err_no !== 0) {
      throw new Error(data.err_msg || `Failed to get ImageX token: err_no=${data.err_no}`)
    }

    const tokenData = data.data?.token
    if (!tokenData || !tokenData.AccessKeyId || !tokenData.SecretAccessKey) {
      throw new Error(`Invalid ImageX token response: ${responseText.substring(0, 200)}`)
    }

    // 解析 ISO 日期为时间戳
    const expiredTime = new Date(tokenData.ExpiredTime).getTime()

    this.cachedImageXToken = {
      AccessKeyId: tokenData.AccessKeyId,
      SecretAccessKey: tokenData.SecretAccessKey,
      SessionToken: tokenData.SessionToken,
      ExpiredTime: expiredTime,
    }
    this.imageXTokenExpiry = expiredTime

    logger.debug('Got ImageX token, expires at:', tokenData.ExpiredTime)

    return this.cachedImageXToken
  }

  /**
   * 申请图片上传
   */
  private async applyImageUpload(token: ImageXToken): Promise<ImageXApplyUploadResponse['Result']['UploadAddress']> {
    const url = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`

    // 生成 AWS4 签名
    const signResult = await signAWS4({
      method: 'GET',
      url,
      accessKeyId: token.AccessKeyId,
      secretAccessKey: token.SecretAccessKey,
      securityToken: token.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(url, {
      method: 'GET',
      headers: {
        ...signResult.headers,
      },
    })

    const data = await response.json() as ImageXApplyUploadResponse

    if (!data.Result?.UploadAddress) {
      throw new Error('Failed to apply image upload')
    }

    return data.Result.UploadAddress
  }

  /**
   * 上传文件到 TOS
   */
  private async uploadToTOS(
    uploadAddress: ImageXApplyUploadResponse['Result']['UploadAddress'],
    file: Blob
  ): Promise<void> {
    const storeInfo = uploadAddress.StoreInfos[0]
    const uploadHost = uploadAddress.UploadHosts[0]

    if (!storeInfo || !uploadHost) {
      throw new Error('Invalid upload address')
    }

    // 构建上传 URL
    const uploadUrl = `https://${uploadHost}/${storeInfo.StoreUri}`

    // 计算 CRC32
    const arrayBuffer = await file.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)
    const crc32Value = crc32(uint8Array)

    logger.debug('Uploading to TOS:', uploadUrl, 'size:', file.size, 'crc32:', crc32Value)

    // 上传文件
    const response = await this.runtime.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': storeInfo.Auth,
        'Content-Type': file.type || 'application/octet-stream',
        'Content-CRC32': crc32Value,
      },
      body: file,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`TOS upload failed: ${response.status} ${text}`)
    }

    logger.debug('TOS upload success')
  }

  /**
   * 提交图片上传
   */
  private async commitImageUpload(
    token: ImageXToken,
    sessionKey: string
  ): Promise<ImageXCommitUploadResponse['Result']> {
    const url = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&SessionKey=${encodeURIComponent(sessionKey)}&ServiceId=${IMAGEX_SERVICE_ID}`

    // 生成 AWS4 签名
    const signResult = await signAWS4({
      method: 'POST',
      url,
      accessKeyId: token.AccessKeyId,
      secretAccessKey: token.SecretAccessKey,
      securityToken: token.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(url, {
      method: 'POST',
      headers: {
        ...signResult.headers,
        'Content-Length': '0',
      },
    })

    const data = await response.json() as ImageXCommitUploadResponse

    if (!data.Result) {
      throw new Error('Failed to commit image upload')
    }

    return data.Result
  }

  /**
   * 获取图片 URL
   */
  private async getImageUrl(uri: string): Promise<string> {
    const url = `https://api.juejin.cn/imagex/v2/get_img_url?aid=${IMAGEX_AID}&uuid=${this.uuid}&uri=${encodeURIComponent(uri)}&img_type=private`

    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const data = await response.json() as {
      data?: { main_url?: string; backup_url?: string }
      err_no?: number
      err_msg?: string
    }

    if (data.err_no && data.err_no !== 0) {
      throw new Error(data.err_msg || 'Failed to get image URL')
    }

    const imageUrl = data.data?.main_url || data.data?.backup_url
    if (!imageUrl) {
      throw new Error('Invalid image URL response')
    }

    return imageUrl
  }

  /**
   * 上传图片 (ImageX 方式) - 内部使用
   */
  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    // 1. 获取上传凭证
    const token = await this.getImageXToken()

    // 2. 申请上传
    const uploadAddress = await this.applyImageUpload(token)
    logger.debug('Apply upload success, session:', uploadAddress.SessionKey.substring(0, 50) + '...')

    // 3. 上传到 TOS
    await this.uploadToTOS(uploadAddress, file)

    // 4. 提交上传
    const commitResult = await this.commitImageUpload(token, uploadAddress.SessionKey)
    logger.debug('Commit upload success:', commitResult.Results?.[0]?.Uri)

    // 5. 获取图片 URL
    const storeUri = uploadAddress.StoreInfos[0]?.StoreUri
    if (!storeUri) {
      throw new Error('No store URI in upload address')
    }

    const imageUrl = await this.getImageUrl(storeUri)
    logger.debug('Got image URL:', imageUrl)

    return imageUrl
  }

  /**
   * 获取分类列表
   */
  async getCategories() {
    const response = await this.runtime.fetch(
      'https://api.juejin.cn/tag_api/v1/query_category_briefs',
      {
        method: 'GET',
        credentials: 'include',
      }
    )

    const data = await response.json() as {
      data?: Array<{ category_id: string; category_name: string }>
    }

    // 转换为标准 Category 格式
    return (data.data || []).map(c => ({
      id: c.category_id,
      name: c.category_name,
    }))
  }
}
