// 附件接缝：把 @ 引用解析成内容。
//
// 本文件先落地类型（events.ts 与 session/types.ts 都依赖它们），实现随后加入。

export type AttachmentRef =
  | { type: 'item'; itemKey: string }
  | { type: 'file'; path: string }

export type AttachmentResult =
  | {
      ok: true
      itemKey?: string
      title: string
      text: string
      /** 源文件实际大小 */
      totalBytes: number
      /** 本次放入上下文的大小 */
      shownBytes: number
      truncated: boolean
    }
  | {
      ok: false
      title?: string
      reason: 'not_found' | 'not_converted' | 'permission_denied' | 'unreadable'
      /** 真实错误文本，不加工 */
      detail: string
    }
