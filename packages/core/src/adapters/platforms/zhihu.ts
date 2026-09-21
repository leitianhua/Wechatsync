/**
 * 知乎适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import md5Lib from 'js-md5'

const logger = createLogger('Zhihu')

// js-md5 导出的是函数本身
const jsMd5 = md5Lib as unknown as (message: string | ArrayBuffer | Uint8Array) => string

/** 发布接口请求体（结构逐项照抓包，值换成运行时值） */
interface ZhihuPublishBody {
  action: 'article'
  data: {
    publish: { traceId: string }
    extra_info: { publisher: 'pc'; pc_business_params: string }
    draft: { disabled: number; id: string; isPublished: boolean }
    commentsPermission: { comment_permission: string }
    creationStatement: { disclaimer_type: string; disclaimer_status: string }
    contentsTables: { table_of_contents_enabled: boolean }
    commercialReportInfo: { isReport: number }
    appreciate: { can_reward: boolean; tagline: string }
    hybridInfo: Record<string, never>
    hybrid: { html: string; textLength: number }
    title: { title: string }
  }
}

/** 发布接口响应（知乎 API 失败时常见 {"error":{...}}） */
interface ZhihuPublishResponse {
  error?: { code?: number | string; name?: string; message?: string }
  [key: string]: unknown
}

export class ZhihuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'zhihu',
    name: '知乎',
    icon: 'https://static.zhihu.com/static/favicon.ico',
    homepage: 'https://www.zhihu.com',
    capabilities: ['article', 'draft', 'image_upload', 'tags', 'cover'],
  }

  /** 预处理配置: 知乎使用 HTML，需要特殊处理 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    // doPreFilter: 移除特殊标签及其父元素
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    // processDocCode: 处理代码块
    processCodeBlocks: true,
    convertSectionToDiv: true,
    removeTrailingBr: true,
    unwrapSingleChildContainers: true,
    unwrapNestedFigures: true,
    compactHtml: true,
    // 清理空内容（与旧 processHtml 一致）
    removeEmptyLines: true,
    removeEmptyDivs: true,
    removeNestedEmptyContainers: true,
  }

  /** 知乎 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.zhihu.com/api/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://zhuanlan.zhihu.com/api/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://api.zhihu.com/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://www.zhihu.com/api/v4/me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'x-requested-with': 'fetch',
        },
      })

      const data = await response.json() as {
        id?: string
        name?: string
        avatar_url?: string
      }

      if (data.id) {
        return {
          isAuthenticated: true,
          userId: data.id,
          username: data.name,
          avatar: data.avatar_url,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    logger.info('Starting publish...')

    const draftOnly = options?.draftOnly ?? true

    let draft: { draftId: string; content: string }
    try {
      draft = await this.saveDraft(article, options)
    } catch (error) {
      return this.createResult(false, { error: (error as Error).message })
    }

    const { draftId, content } = draft
    const draftUrl = `https://zhuanlan.zhihu.com/p/${draftId}/edit`

    if (draftOnly) {
      return this.createResult(true, {
        postId: draftId,
        postUrl: draftUrl,
        draftOnly: true,
      })
    }

    // 直发：publish 走 www.zhihu.com 域，另起一个 Header 规则作用域。
    // 不能嵌在上面的 withHeaderRules 里——DNR 同优先级只会命中一条规则，
    // 先加的 '*://www.zhihu.com/api/*' 规则会抢走这次请求，Origin/Referer 覆盖就丢了。
    try {
      await this.publishDraft(draftId, article.title, content)
    } catch (error) {
      const message = (error as Error).message
      logger.error('Publish failed:', message)
      // 草稿已经保存成功，把草稿信息一起带回，方便用户去草稿箱处理
      return this.createResult(false, {
        postId: draftId,
        postUrl: draftUrl,
        draftOnly: true,
        error: `草稿已保存但发布失败，可前往知乎草稿箱手动发布: ${message}`,
      })
    }

    // 草稿 id 即文章 id
    const postUrl = `https://zhuanlan.zhihu.com/p/${draftId}`
    logger.info('Published:', postUrl)

    return this.createResult(true, {
      postId: draftId,
      postUrl,
      draftOnly: false,
    })
  }

  /**
   * 草稿链路: 建草稿 -> 传图 -> 内容转换 -> PATCH 写入
   * 返回草稿 id 和最终写进草稿的 HTML（发布时要用同一份内容）
   */
  private async saveDraft(
    article: Article,
    options?: PublishOptions
  ): Promise<{ draftId: string; content: string }> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 1. 创建草稿
      const createResponse = await this.runtime.fetch('https://zhuanlan.zhihu.com/api/articles/drafts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-with': 'fetch',
        },
        body: JSON.stringify({
          title: article.title,
          content: '',
          delta_time: 0,
        }),
      })

      // 检查响应状态和内容
      const responseText = await createResponse.text()
      logger.debug('Create draft response:', createResponse.status, responseText.substring(0, 200))

      if (!createResponse.ok) {
        throw new Error(`创建草稿失败: ${createResponse.status} - ${responseText}`)
      }

      // 尝试解析 JSON
      let createData: { id?: string }
      try {
        createData = JSON.parse(responseText)
      } catch {
        throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
      }

      if (!createData.id) {
        throw new Error('创建草稿失败: 无效响应')
      }

      const draftId = createData.id
      logger.debug('Draft created:', draftId)

      // 2. 使用预处理好的 HTML（Content Script 已处理代码块、图片、特殊标签等）
      // 知乎使用 HTML 格式
      let content = article.html || ''

      // 3. 处理图片（section → div 转换已在 preprocessConfig 中处理）
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['zhimg.com', 'pic1.zhimg.com', 'pic2.zhimg.com', 'pic3.zhimg.com', 'pic4.zhimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 知乎特定的内容转换
      content = this.transformContent(content)

      // 5. 更新草稿内容
      const updateResponse = await this.runtime.fetch(
        `https://zhuanlan.zhihu.com/api/articles/${draftId}/draft`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-requested-with': 'fetch',
          },
          body: JSON.stringify({
            title: article.title,
            content: content,
          }),
        }
      )

      // 检查更新响应 (PATCH 可能返回空响应或 204)
      if (!updateResponse.ok) {
        const updateText = await updateResponse.text()
        logger.error('Update draft failed:', updateResponse.status, updateText)
        throw new Error(`更新草稿失败: ${updateResponse.status}`)
      }

      logger.debug('Draft updated, status:', updateResponse.status)

      return { draftId, content }
    })
  }

  /**
   * 正式发布: POST https://www.zhihu.com/api/v4/content/publish
   * 请求体按抓包结构拼装（草稿 id 即文章 id）
   */
  private async publishDraft(draftId: string, title: string, html: string): Promise<void> {
    const xsrfToken = await this.getXsrfToken()
    if (!xsrfToken) {
      throw new Error('未取到 _xsrf，请确认已登录知乎后重试')
    }

    // 抓包口径: 去掉标签后的文本长度
    const textLength = html.replace(/<[^>]*>/g, '').length

    // pc_business_params 在抓包里是"字符串里的 JSON"，交给 JSON.stringify 处理转义层次
    const pcBusinessParams = {
      commentPermission: 'anyone',
      disclaimer_type: 'none',
      disclaimer_status: 'close',
      table_of_contents_enabled: false,
      content: html,
      title,
      commercial_report_info: { commercial_types: [] as string[] },
      commercial_zhitask_bind_info: null,
      canReward: false,
    }

    const body: ZhihuPublishBody = {
      action: 'article',
      data: {
        publish: {
          traceId: `${Date.now()},${this.createUuid()}`,
        },
        extra_info: {
          publisher: 'pc',
          pc_business_params: JSON.stringify(pcBusinessParams),
        },
        draft: {
          disabled: 1,
          id: draftId,
          isPublished: false,
        },
        commentsPermission: {
          comment_permission: 'anyone',
        },
        creationStatement: {
          disclaimer_type: 'none',
          disclaimer_status: 'close',
        },
        contentsTables: {
          table_of_contents_enabled: false,
        },
        commercialReportInfo: {
          isReport: 0,
        },
        appreciate: {
          can_reward: false,
          tagline: '',
        },
        hybridInfo: {},
        hybrid: {
          html,
          textLength,
        },
        title: {
          title,
        },
      },
    }

    const rules = [
      {
        urlFilter: '*://www.zhihu.com/api/v4/content/publish',
        headers: {
          'x-requested-with': 'fetch',
          'Origin': 'https://zhuanlan.zhihu.com',
          'Referer': `https://zhuanlan.zhihu.com/p/${draftId}/edit`,
        },
        resourceTypes: ['xmlhttprequest'],
      },
    ]

    return this.withHeaderRules(rules, async () => {
      const response = await this.runtime.fetch('https://www.zhihu.com/api/v4/content/publish', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-with': 'fetch',
          'x-xsrftoken': xsrfToken,
          // 抓包带的固定串；x-zse-96 / x-zst-81 签名未实现（登录 cookie 下写接口通常免签）
          'x-zse-93': '101_3_3.0',
        },
        body: JSON.stringify(body),
      })

      const responseText = await response.text()
      logger.debug('Publish response:', response.status, responseText.substring(0, 300))

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('未登录或登录已过期，请重新登录知乎')
        }
        if (response.status === 403) {
          // 实测(2026-09-21): 登录态正常时发布接口也回 403（code 10001 请求参数异常），
          // 是缺 x-zse-96 风控签名被拦，不是登录问题
          throw new Error('发布被知乎风控拦截(403)：发布接口需要 x-zse-96 签名，适配器未实现；草稿已存，请到草稿箱手动点发布')
        }
        throw new Error(`发布失败: ${response.status} - ${responseText}`)
      }

      // HTTP 200 仍可能带 error 字段，需要读响应体判断
      let publishData: ZhihuPublishResponse
      try {
        publishData = responseText.trim()
          ? JSON.parse(responseText) as ZhihuPublishResponse
          : {}
      } catch {
        throw new Error(`发布失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
      }

      if (publishData.error) {
        throw new Error(`发布失败: ${publishData.error.message || JSON.stringify(publishData.error)}`)
      }
    })
  }

  /**
   * 发布接口需要的 x-xsrftoken，取值就是 cookie 里的 _xsrf
   */
  private async getXsrfToken(): Promise<string | null> {
    if (!this.runtime.getCookie) {
      logger.warn('getCookie API not available')
      return null
    }

    // _xsrf 挂在 .zhihu.com 域下，几种域名写法都试一遍
    for (const domain of ['www.zhihu.com', '.zhihu.com', 'zhihu.com']) {
      const value = await this.runtime.getCookie(domain, '_xsrf')
      if (value) {
        logger.debug('Got _xsrf from cookies API:', domain)
        return value
      }
    }

    logger.warn('Could not find _xsrf')
    return null
  }

  /**
   * 生成 traceId 用的 uuid（抓包形如 "<毫秒时间戳>,<uuid>"）
   */
  private createUuid(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // 补上 v4 的版本位和变体位
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  /**
   * 知乎内容转换 - 适配 Draft.js 编辑器格式
   */
  private transformContent(content: string): string {
    let result = content

    // 1. 转换表格格式 - 知乎 Draft.js 编辑器需要特定格式
    result = this.transformTables(result)

    // 2. 图片格式 - 知乎需要 figure 包裹
    result = result.replace(
      /<img([^>]+)src="([^"]+)"([^>]*)>/gi,
      '<figure><img$1src="$2"$3></figure>'
    )

    // 3. 代码块格式
    result = result.replace(
      /<pre><code class="language-(\w+)">/gi,
      '<pre lang="$1"><code>'
    )

    // 4. 移除微信样式属性 (但保留知乎的 data-draft-* 属性)
    result = result.replace(/\s*data-(?!draft)[a-z-]+="[^"]*"/gi, '')
    result = result.replace(/\s*style="[^"]*"/gi, '')

    return result
  }

  /**
   * 转换表格为知乎 Draft.js 格式
   */
  private transformTables(html: string): string {
    // 1. 解包 figure 中的 table
    let result = html.replace(
      /<figure[^>]*>\s*(<table[\s\S]*?<\/table>)\s*<\/figure>/gi,
      '$1'
    )

    // 2. 转换 table 结构
    result = result.replace(
      /<table[^>]*>([\s\S]*?)<\/table>/gi,
      (_match, tableContent) => {
        // 提取 thead 中的行
        const theadMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
        // 提取 tbody 中的行
        const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)

        let headerRows = ''
        let bodyRows = ''

        if (theadMatch) {
          // 处理表头行 - 确保使用 <th>
          headerRows = theadMatch[1]
            .replace(/<td([^>]*)>/gi, '<th$1>')
            .replace(/<\/td>/gi, '</th>')
        }

        if (tbodyMatch) {
          bodyRows = tbodyMatch[1]
        } else {
          // 没有 tbody，整个内容作为 body（排除 thead）
          bodyRows = tableContent
            .replace(/<thead[^>]*>[\s\S]*?<\/thead>/gi, '')
            .replace(/<\/?tbody[^>]*>/gi, '')
        }

        // 如果没有 thead，检查第一行是否全是 th
        if (!theadMatch) {
          const firstRowMatch = bodyRows.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)
          if (firstRowMatch) {
            const firstRowContent = firstRowMatch[1]
            if (/<th[^>]*>/i.test(firstRowContent) && !/<td[^>]*>/i.test(firstRowContent)) {
              headerRows = firstRowMatch[0]
              bodyRows = bodyRows.replace(firstRowMatch[0], '')
            }
          }
        }

        // 组装知乎格式的表格
        return `<table data-draft-node="block" data-draft-type="table" data-size="normal" data-row-style="normal"><tbody>${headerRows}${bodyRows}</tbody></table>`
      }
    )

    return result
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.uploadImageBinaryInternal(file)
  }

  /**
   * 通过 URL 上传图片
   * 支持远程 URL 和 data URI
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 检测 data URI，使用二进制上传
    if (src.startsWith('data:')) {
      logger.debug('Detected data URI, using binary upload')
      const blob = await fetch(src).then(r => r.blob())
      const url = await this.uploadImageBinaryInternal(blob)
      return { url }
    }

    // 远程 URL 使用知乎 URL 上传 API
    const response = await this.runtime.fetch('https://zhuanlan.zhihu.com/api/uploaded_images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-requested-with': 'fetch',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        url: src,
        source: 'article',
      }),
    })

    const data = await response.json() as { src?: string; hash?: string }

    if (data.src) {
      return { url: data.src }
    }

    throw new Error('图片上传失败')
  }

  /**
   * 上传图片 (二进制方式) - 内部使用
   */
  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    // 1. 计算图片 hash
    const buffer = await file.arrayBuffer()
    const imageHash = jsMd5(buffer)

    // 2. 请求上传凭证
    const tokenResponse = await this.runtime.fetch('https://api.zhihu.com/images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_hash: imageHash,
        source: 'article',
      }),
    })

    const tokenData = await tokenResponse.json() as {
      upload_file: {
        state: number
        image_id: string
        object_key: string
      }
      upload_token: {
        access_id: string
        access_key: string
        access_token: string
      }
    }
    const uploadFile = tokenData.upload_file

    // 3. 检查图片是否已存在
    if (uploadFile.state === 1) {
      const imgDetail = await this.waitForImageReady(uploadFile.image_id)
      const objectKey = imgDetail.original_hash
      return `https://pic4.zhimg.com/${objectKey}`
    }

    // 4. 上传到 OSS
    const token = tokenData.upload_token
    await this.ossUpload(
      'https://zhihu-pics-upload.zhimg.com',
      uploadFile.object_key,
      file,
      token
    )

    // 5. 处理 GIF 扩展名
    let objectKey = uploadFile.object_key
    if (file.type === 'image/gif') {
      objectKey = objectKey + '.gif'
    }

    return `https://pic4.zhimg.com/${objectKey}`
  }

  /**
   * 等待图片处理完成
   */
  private async waitForImageReady(imageId: string): Promise<{ original_hash: string }> {
    const maxRetries = 10
    for (let i = 0; i < maxRetries; i++) {
      const response = await this.runtime.fetch(`https://api.zhihu.com/images/${imageId}`, {
        credentials: 'include',
      })
      const data = await response.json() as { status?: string; original_hash?: string }

      if (data.status === 'completed' || data.original_hash) {
        return data as { original_hash: string }
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Image processing timeout')
  }

  /**
   * OSS 上传 - 手动 V1 签名
   */
  private async ossUpload(
    endpoint: string,
    objectKey: string,
    blob: Blob,
    token: { access_id: string; access_key: string; access_token: string }
  ): Promise<void> {
    const contentType = blob.type || 'application/octet-stream'
    const url = `${endpoint}/${objectKey}`

    // OSS 日期格式 (GMT)
    const ossDate = new Date().toUTCString()
    const ossUserAgent = 'aliyun-sdk-js/6.8.0'

    // 构建 CanonicalizedOSSHeaders (按字母顺序排列，每行以\n结尾)
    const ossHeaders: Record<string, string> = {
      'x-oss-date': ossDate,
      'x-oss-security-token': token.access_token,
      'x-oss-user-agent': ossUserAgent,
    }
    // 按字母顺序排序，每个 header 以 \n 结尾
    const canonicalizedOSSHeaders = Object.keys(ossHeaders)
      .sort()
      .map(key => `${key}:${ossHeaders[key]}`)
      .join('\n')

    // CanonicalizedResource: /bucket/object-key
    // bucket 名是 zhihu-pics (不是 zhihu-pics-upload)
    const bucket = 'zhihu-pics'
    const canonicalizedResource = `/${bucket}/${objectKey}`

    // 构建待签名字符串
    // VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedOSSHeaders + "\n" + CanonicalizedResource
    const stringToSign =
      'PUT\n' +
      '\n' +  // Content-MD5 (空)
      contentType + '\n' +
      ossDate + '\n' +  // Date (与 x-oss-date 相同)
      canonicalizedOSSHeaders + '\n' +
      canonicalizedResource

    // 计算 HMAC-SHA1 签名
    const signature = await this.hmacSha1Base64(token.access_key, stringToSign)
    const authorization = `OSS ${token.access_id}:${signature}`

    logger.debug('OSS stringToSign:', JSON.stringify(stringToSign))
    logger.debug('OSS authorization:', authorization)

    // 添加 header 规则来设置正确的 Origin
    let ruleId: string | undefined
    try {
      if (this.runtime.headerRules) {
        ruleId = await this.runtime.headerRules.add({
          urlFilter: '*://zhihu-pics-upload.zhimg.com/*',
          headers: {
            'Origin': 'https://zhuanlan.zhihu.com',
            'Referer': 'https://zhuanlan.zhihu.com/',
          },
          resourceTypes: ['xmlhttprequest'],
        })
        logger.debug('Added header rule for OSS upload:', ruleId)
      }

      const response = await this.runtime.fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Authorization': authorization,
          'x-oss-date': ossDate,
          'x-oss-security-token': token.access_token,
          'x-oss-user-agent': 'aliyun-sdk-js/6.8.0',
        },
        body: blob,
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error('OSS upload failed:', response.status, text)
        throw new Error(`OSS upload failed: ${response.status}`)
      }
      logger.debug('OSS upload success')
    } finally {
      // 清理 header 规则
      if (ruleId && this.runtime.headerRules) {
        await this.runtime.headerRules.remove(ruleId)
        logger.debug('Removed header rule:', ruleId)
      }
    }
  }

  /**
   * HMAC-SHA1 签名并返回 Base64 (使用 Web Crypto API)
   */
  private async hmacSha1Base64(key: string, message: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(key)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
  }
}
