/**
 * 微信公众号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import juice from 'juice'

const logger = createLogger('Weixin')

interface WeixinMeta {
  token: string
  userName: string
  nickName: string
  ticket: string
  svrTime: number
  avatar: string
}

// 微信公众号的默认 CSS 样式
const WEIXIN_CSS = `
p {
  color: rgb(51, 51, 51);
  font-size: 15px;
  line-height: 1.75em;
  margin: 0 0 1em 0;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: bold;
}
h1 { font-size: 1.25em; line-height: 1.4em; margin: 1em 0 0.5em 0; }
h2 { font-size: 1.125em; margin: 1em 0 0.5em 0; }
h3 { font-size: 1.05em; margin: 0.8em 0 0.4em 0; }
h4, h5, h6 { font-size: 1em; margin: 0.8em 0 0.4em 0; }
li p { margin: 0; }
ul, ol { margin: 1em 0; padding-left: 2em; }
li { margin-bottom: 0.4em; }
pre, tt, code, kbd, samp { font-family: monospace; }
pre { white-space: pre; margin: 1em 0; }
blockquote { border-left: 4px solid #ddd; padding-left: 1em; margin: 1em 0; color: #666; }
hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
i, cite, em, var, address { font-style: italic; }
b, strong { font-weight: bolder; }
`

/** 声明原创：0 = 不声明，1 = 声明原创 */
const DECLARE_ORIGINAL = 1

/** 合集。id 留空则不挂合集；本机账号的「睡前故事」合集 */
const ALBUM: { id: string; title: string } = { id: '4739927709437706250', title: '睡前故事' }

/** 作者署名（笔名），显示在标题下方 */
const AUTHOR = '啵啵'

export class WeixinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'weixin',
    name: '微信公众号',
    icon: 'https://mp.weixin.qq.com/favicon.ico',
    homepage: 'https://mp.weixin.qq.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 微信公众号使用 HTML 格式，移除非微信域名链接，压缩标签间空白避免 ProseMirror 产生空节点 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
    keepLinkDomains: ['mp.weixin.qq.com', 'weixin.qq.com'],
    compactHtml: true,
  }

  private weixinMeta: WeixinMeta | null = null

  /** 微信公众号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.weixin.qq.com/cgi-bin/*',
      headers: {
        'Origin': 'https://mp.weixin.qq.com',
        'Referer': 'https://mp.weixin.qq.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 回读草稿做核验。只返回「数出来的指标」，不把草稿原文透出去。
   * 一条图文可能有多个条目（头条+次条），所以正文指标按 items 数组返回，草稿级字段只给一份。
   */
  async checkDraft(appmsgid: string): Promise<{
    appmsgid: string
    count: number
    title: string
    author: string
    cover: string
    copyrightType: string
    albumId: string
    items: {
      title: string
      chars: number
      images: number
      gifs: number
      sections: number
      rounded: number
      paraRuns: number[]
      tailParas: number
    }[]
  }> {
    if (!this.weixinMeta) throw new Error('未登录')
    const { token } = this.weixinMeta
    const id = String(appmsgid).replace(/[^\d]/g, '')
    if (!id) throw new Error('appmsgid 只能是数字')

    const editRaw = await (await this.runtime.fetch(
      `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=edit&type=77&appmsgid=${id}&token=${token}&lang=zh_CN&f=json&ajax=1`,
      { method: 'GET', credentials: 'include' }
    )).text()
    const editJson = (JSON.parse(editRaw.replace(/^[^{]*/, '')) as {
      AppMsgItemList?: {
        Title?: string; Author?: string; ImgURL?: string
        Content?: string; MutilAppMsgItemList?: { Title?: string; Content?: string }[]
      }[]
    }).AppMsgItemList || []
    const head = editJson[0]
    if (!head) throw new Error(`草稿 ${id} 没读回来（可能已被删除，或 appmsgid 不对）`)

    // 多个条目时微信把每个条目当成 AppMsgItemList 的一项返回；老结构则塞在 MutilAppMsgItemList 里
    const raw = editJson.length > 1
      ? editJson
      : (head.MutilAppMsgItemList?.length ? head.MutilAppMsgItemList : [head])
    const items0 = raw.filter((x) => x?.Content)
    if (!items0.length) throw new Error(`草稿 ${id} 没读回正文（可能已被删除，或 appmsgid 不对）`)
    const paras = (s: string) => (s.match(/<p[\s>]/g) || []).length
    const items = items0.map((x) => {
      const content = x.Content as string
      const parts = content.split('<img')
      return {
        title: x.Title || '',
        chars: content.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s+/g, '').length,
        images: parts.length - 1,
        gifs: (content.match(/wx_fmt=gif/g) || []).length,
        sections: (content.match(/<section/g) || []).length,
        rounded: (content.match(/border-radius:\s*12px/g) || []).length,
        // 每张图前面有几个自然段 —— "文字-图-文字" 真落地的指纹
        paraRuns: parts.slice(1).map((_, k) => paras(parts[k])),
        tailParas: paras(parts[parts.length - 1]),
      }
    })

    const page = await (await this.runtime.fetch(
      `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${id}&token=${token}&lang=zh_CN`,
      { method: 'GET', credentials: 'include' }
    )).text()

    return {
      appmsgid: id,
      count: items.length,
      title: head.Title || '',
      author: head.Author || '',
      cover: (head.ImgURL || '').slice(0, 46),
      copyrightType: /copyright_type":(\d+)/.exec(page)?.[1] || '',
      albumId: /appmsg_album_infos":\[\{"id":"(\d+)"/.exec(page)?.[1] || '',
      items,
    }
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://mp.weixin.qq.com/',
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const html = await response.text()

      const tokenMatch = html.match(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/)
      if (!tokenMatch) {
        logger.debug(' No token found')
        return { isAuthenticated: false }
      }

      const ticketMatch = html.match(/ticket:\s*["']([^"']+)["']/)
      const userNameMatch = html.match(/user_name:\s*["']([^"']+)["']/)
      const nickNameMatch = html.match(/nick_name:\s*["']([^"']+)["']/)
      const timeMatch = html.match(/time:\s*["'](\d+)["']/)
      const headImgMatch = html.match(/head_img:\s*['"]([^'"]+)['"]/)

      const avatarMatch = html.match(/class="weui-desktop-account__thumb"[^>]*src="([^"]+)"/)
      let avatar = avatarMatch ? avatarMatch[1] : (headImgMatch ? headImgMatch[1] : '')
      if (avatar.startsWith('http://')) {
        avatar = avatar.replace('http://', 'https://')
      }

      this.weixinMeta = {
        token: tokenMatch[1],
        userName: userNameMatch ? userNameMatch[1] : '',
        nickName: nickNameMatch ? nickNameMatch[1] : '',
        ticket: ticketMatch ? ticketMatch[1] : '',
        svrTime: timeMatch ? Number(timeMatch[1]) : Date.now() / 1000,
        avatar,
      }

      logger.debug(' Auth info:', {
        userName: this.weixinMeta.userName,
        nickName: this.weixinMeta.nickName,
        hasToken: !!this.weixinMeta.token,
      })

      return {
        isAuthenticated: true,
        userId: this.weixinMeta.userName,
        username: this.weixinMeta.nickName,
        avatar: this.weixinMeta.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 一条图文里的第 i 个条目要提交的那批字段（微信用 title0/content0/fileid0… 这种下标约定）。
   * 两条目就是把这套再写一遍、下标换成 1。
   */
  private itemFields(i: number, it: { title: string; content: string; fileId: string; cdnUrl: string }): Record<string, string> {
    const k = (name: string) => `${name}${i}`
    return {
      [k('ad_video_transition')]: '',
      [k('can_reward')]: '0',
      [k('related_video')]: '',
      [k('is_video_recommend')]: '-1',
      [k('title')]: it.title,
      [k('author')]: AUTHOR,
      [k('writerid')]: '0',
      [k('fileid')]: it.fileId,
      [k('digest')]: '',
      [k('auto_gen_digest')]: '1',
      [k('content')]: it.content,
      [k('sourceurl')]: '',
      [k('need_open_comment')]: '1',
      [k('only_fans_can_comment')]: '0',
      [k('cdn_url')]: it.cdnUrl,
      [k('cdn_235_1_url')]: '',
      [k('cdn_1_1_url')]: '',
      [k('cdn_url_back')]: it.cdnUrl,
      [k('crop_list')]: '',
      [k('music_id')]: '',
      [k('video_id')]: '',
      [k('voteid')]: '',
      [k('voteismlt')]: '',
      [k('supervoteid')]: '',
      [k('cardid')]: '',
      [k('cardquantity')]: '',
      [k('cardlimit')]: '',
      [k('vid_type')]: '',
      [k('show_cover_pic')]: '0',
      [k('shortvideofileid')]: '',
      [k('copyright_type')]: String(DECLARE_ORIGINAL),
      [k('releasefirst')]: '',
      [k('platform')]: '',
      [k('reprint_permit_type')]: '',
      [k('allow_reprint')]: '',
      [k('allow_reprint_modify')]: '',
      [k('original_article_type')]: '',
      // 合集：微信要的是 JSON 字符串 {"appmsg_album_infos":[{"id":..,"title":..}]}
      [k('appmsg_album_info')]: ALBUM.id
        ? JSON.stringify({ appmsg_album_infos: [{ id: ALBUM.id, title: ALBUM.title }] })
        : JSON.stringify({ appmsg_album_infos: [] }),
      [k('ori_white_list')]: '',
      [k('free_content')]: '',
      [k('fee')]: '0',
      [k('ad_id')]: '',
      [k('guide_words')]: '',
      [k('is_share_copyright')]: '0',
      [k('share_copyright_url')]: '',
      [k('source_article_type')]: '',
      [k('reprint_recommend_title')]: '',
      [k('reprint_recommend_content')]: '',
      [k('share_page_type')]: '0',
      [k('share_imageinfo')]: '{"list":[]}',
      [k('share_video_id')]: '',
      [k('dot')]: '{}',
      [k('share_voice_id')]: '',
      [k('insert_ad_mode')]: '2',
      [k('categories_list')]: '[]',
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.weixinMeta) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录微信公众号')
        }
      }

      // 一条图文可以有多个条目；没给 items 就是单条目（老行为不变）
      const list: { title: string; content: string; cover?: string }[] =
        Array.isArray((article as any).items) && (article as any).items.length
          ? (article as any).items
          : [{ title: article.title, content: (article as any).rawHtml || article.html || '', cover: article.cover }]
      const rawPassthrough = article.source?.platform === 'weixin' && !!(article as any).rawHtml

      const prepared: { title: string; content: string; fileId: string; cdnUrl: string }[] = []
      for (const it of list) {
        let content = it.content || ''
        if (rawPassthrough) {
          logger.info('Source is WeChat, using raw HTML, skipping content processing')
        } else {
          content = this.processLatex(content)
          content = this.stripExternalLinks(content)
          content = await this.processImages(
            content,
            (src) => this.uploadImageByUrl(src),
            {
              skipPatterns: ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'],
              onProgress: options?.onImageProgress,
            }
          )
          content = this.processContent(content)
        }
        // 每个条目一张自己的封面，fileid + cdn_url 用来绑定
        let fileId = ''
        let cdnUrl = ''
        if (it.cover) {
          try {
            const r = await this.uploadImageByUrl(it.cover)
            cdnUrl = r.url
            fileId = String(r.attrs?.fileid ?? '')
          } catch (err) {
            logger.warn('Cover upload failed, skipping cover:', (err as Error).message)
          }
        }
        prepared.push({ title: it.title, content, fileId, cdnUrl })
      }

      const appmsgid = String((article as any).appmsgid || '')
      // 每个条目一份的"索引信息"。只发 count 微信会丢掉第二个条目，
      // 必须同时给 articlenum 和 req.idx_infos（字段抓自编辑器真实保存请求）
      const idxInfo = {
        save_old: 0,
        cps_info: { cps_import: 0 },
        red_packet_cover_list: { list: [] },
        podcast_task_info: null,
        love_like_style_info: { style: 0 },
        claim_source: {},
        line_info: { scene: 2 },
        window_product: {},
        link_info: {},
        appmsg_link: {},
        weapp_link: {},
        topic_card: {},
        yqj_info: {},
        ai_pic_info: { cover_source: 0, ai_pic_id: [], cover_pic_id: '', ai_cover_auto_gen: 0 },
        single_video_snap_card: {},
        product_activity: {},
        footer_gift_activity: {},
        footer_common_shops: [],
        footer_product_card: {},
        location: {},
      }
      const fields: Record<string, string> = {
        token: this.weixinMeta!.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: '1',
        random: String(Math.random()),
        AppMsgId: appmsgid,
        count: String(prepared.length),
        articlenum: String(prepared.length),
        req: JSON.stringify({
          idx_infos: prepared.map(() => idxInfo),
          ...(appmsgid ? { appmsg_id: Number(appmsgid) } : {}),
          is_use_flag: 0,
        }),
        data_seq: '0',
        operate_from: 'Chrome',
        isnew: '0',
      }
      prepared.forEach((it, i) => Object.assign(fields, this.itemFields(i, it)))

      const formData = new URLSearchParams(fields)

      // 带 AppMsgId 时必须走 sub=update，走 sub=create 微信会另建一篇新草稿
      const response = await this.runtime.fetch(
        `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=${appmsgid ? 'update' : 'create'}&type=77&token=${this.weixinMeta!.token}&lang=zh_CN`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData,
        }
      )

      const res = await response.json() as {
        appMsgId?: string
        ret?: number
        base_resp?: { ret: number; err_msg?: string }
      }

      logger.debug(' Save response:', res)

      if (!res.appMsgId) {
        const errMsg = this.formatError(res)
        throw new Error(errMsg)
      }

      const draftUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${res.appMsgId}&token=${this.weixinMeta!.token}&lang=zh_CN`

      return this.createResult(true, {
        postId: res.appMsgId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.weixinMeta) {
      throw new Error('未登录')
    }

    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    const timestamp = Date.now()
    const fileName = `${timestamp}.jpg`

    formData.append('type', imageBlob.type || 'image/jpeg')
    formData.append('id', String(timestamp))
    formData.append('name', fileName)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(imageBlob.size))
    formData.append('file', imageBlob, fileName)

    const { token, userName, ticket, svrTime } = this.weixinMeta
    const seq = Date.now()

    const response = await this.runtime.fetch(
      `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&scene=8&writetype=doublewrite&groupid=1&ticket_id=${userName}&ticket=${ticket}&svr_time=${svrTime}&token=${token}&lang=zh_CN&seq=${seq}&t=${Math.random()}`,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await response.json() as {
      cdn_url?: string
      content?: string
      base_resp?: { err_msg: string; ret: number }
    }

    logger.debug(' Image upload response:', res)

    if (res.base_resp?.err_msg !== 'ok' || !res.cdn_url) {
      throw new Error('图片上传失败: ' + src)
    }

    return {
      url: res.cdn_url,
      // 保留 fileid(res.content),供封面绑定使用
      attrs: res.content ? { fileid: res.content } : undefined,
    }
  }

  private isLatexFormula(text: string): boolean {
    if (/[\\^_{}]/.test(text)) return true
    if (/[α-ωΑ-Ω]/.test(text)) return true
    if (/[∑∏∫∂∇∞≠≤≥±×÷√]/.test(text)) return true
    return false
  }

  private processLatex(content: string): string {
    const LATEX_API = 'https://latex.codecogs.com/png.latex'

    content = content.replace(/\$\$([^$]+)\$\$/g, (match, latex) => {
      if (!this.isLatexFormula(latex)) return match
      const encoded = encodeURIComponent(latex.trim())
      return `<p style="text-align: center;"><img src="${LATEX_API}?\\dpi{150}${encoded}" alt="formula" style="vertical-align: middle; max-width: 100%;"></p>`
    })

    content = content.replace(/\$([^$]+)\$/g, (match, latex) => {
      if (!this.isLatexFormula(latex)) return match
      const encoded = encodeURIComponent(latex.trim())
      return `<img src="${LATEX_API}?\\dpi{120}${encoded}" alt="formula" style="vertical-align: middle;">`
    })

    return content
  }

  private processContent(content: string): string {
    const wrapped = `<section style="margin-left: 6px; margin-right: 6px; line-height: 1.75em;">${content}</section>`
    return juice.inlineContent(wrapped, WEIXIN_CSS)
  }

  /**
   * 移除外部链接（微信不允许非 mp.weixin.qq.com 域名的链接）
   * 将 <a href="外部链接">文字</a> 转换为 文字
   */
  private stripExternalLinks(content: string): string {
    // 匹配 <a> 标签，保留微信域名的链接
    return content.replace(
      /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (match, href, text) => {
        // 保留微信域名的链接
        if (href && (
          href.includes('mp.weixin.qq.com') ||
          href.includes('weixin.qq.com') ||
          href.startsWith('#') ||  // 锚点链接
          href.startsWith('javascript:')  // JS 链接
        )) {
          return match
        }
        // 外部链接只保留文字
        return text
      }
    )
  }

  private formatError(res: { ret?: number; base_resp?: { ret: number } }): string {
    const ret = res.ret ?? res.base_resp?.ret

    const errorMap: Record<number, string> = {
      [-6]: '请输入验证码',
      [-8]: '请输入验证码',
      [-1]: '系统错误，请注意备份内容后重试',
      [-2]: '参数错误，请注意备份内容后重试',
      [-5]: '服务错误，请注意备份内容后重试',
      [-99]: '内容超出字数，请调整',
      [-206]: '服务负荷过大，请稍后重试',
      [200002]: '参数错误，请注意备份内容后重试',
      [200003]: '登录态超时，请重新登录',
      [412]: '图文中含非法外链',
      [62752]: '可能含有具备安全风险的链接，请检查',
      [64502]: '你输入的微信号不存在',
      [64505]: '发送预览失败，请稍后再试',
      [64506]: '保存失败，链接不合法',
      [64507]: '内容不能包含外部链接',
      [64562]: '请勿插入非微信域名的链接',
      [64509]: '正文中不能包含超过3个视频',
      [64515]: '当前素材非最新内容，请重新打开并编辑',
      [64702]: '标题超出64字长度限制',
      [64703]: '摘要超出120字长度限制',
      [64705]: '内容超出字数，请调整',
      [10806]: '正文不能有违规内容，请重新编辑',
      [10807]: '内容不能违反公众平台协议',
      [220001]: '素材管理中的存储数量已达上限',
      [220002]: '图片库已达到存储上限',
    }

    return errorMap[ret as number] || `同步失败 (错误码: ${ret})`
  }
}
