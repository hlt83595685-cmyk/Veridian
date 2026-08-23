// 附件接缝：把 @ 引用解析成内容。
//
// 三条规矩，全部来自旧实现的教训：
//   1. 读全文，不设武断上限。旧实现截到 8000 字符，而论文 30–80KB，只覆盖约 15%
//      ——用户问结论/讨论时它当然答不出。放不下由装配器按预算截断，并如实标注。
//   2. 失败绝不静默。旧实现把异常 catch 掉后告诉模型「没有转换文本」——那句谎
//      正是在训练模型放弃 @ 而去检索全库。
//   3. 失败必须分类，让模型能给出正确的下一步。
import { Service, type Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'fs'
import { getDb } from '../../db'
import { assertReadable } from '../../security/pathGuard'

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

/** 外部依赖注入，测试可替换（避免碰数据库与真实文件系统）。 */
export interface AttachmentDeps {
  findItem(key: string): { id: number; title: string | null } | null
  findMarkdownPath(itemId: number): string | null
  assertReadable(p: string): string
  readText(p: string): string
}

export interface AttachmentResolver {
  resolve(ref: AttachmentRef): Promise<AttachmentResult>
}

export function makeAttachmentResolver(deps: AttachmentDeps): AttachmentResolver {
  return {
    async resolve(ref: AttachmentRef): Promise<AttachmentResult> {
      let path: string
      let title: string

      if (ref.type === 'item') {
        const item = deps.findItem(ref.itemKey)
        if (!item) return { ok: false, reason: 'not_found', detail: `no item with key ${ref.itemKey}` }
        title = item.title ?? ref.itemKey
        const md = deps.findMarkdownPath(item.id)
        if (!md) return { ok: false, title, reason: 'not_converted', detail: 'no markdown attachment' }
        path = md
      } else {
        path = ref.path
        title = ref.path
      }

      let real: string
      try {
        real = deps.assertReadable(path)
      } catch (err) {
        return { ok: false, title, reason: 'permission_denied', detail: (err as Error).message }
      }

      try {
        const text = deps.readText(real)
        return {
          ok: true,
          itemKey: ref.type === 'item' ? ref.itemKey : undefined,
          title,
          text,
          totalBytes: text.length,
          shownBytes: text.length,
          truncated: false,
        }
      } catch (err) {
        return { ok: false, title, reason: 'unreadable', detail: (err as Error).message }
      }
    },
  }
}

/** 生产依赖：读库与真实文件系统。 */
export const productionDeps: AttachmentDeps = {
  findItem: (key) =>
    (getDb().prepare('SELECT id, title FROM items WHERE key = ? AND deleted = 0').get(key) as
      | { id: number; title: string | null }
      | undefined) ?? null,
  findMarkdownPath: (itemId) =>
    (getDb()
      .prepare("SELECT path FROM attachments WHERE item_id = ? AND type = 'markdown' AND path IS NOT NULL LIMIT 1")
      .get(itemId) as { path: string } | undefined)?.path ?? null,
  assertReadable,
  readText: (p) => readFileSync(p, 'utf-8'),
}

export class AttachmentService extends Service {
  private readonly impl = makeAttachmentResolver(productionDeps)

  constructor(ctx: Context) {
    super(ctx, 'attachment')
  }

  resolve(ref: AttachmentRef): Promise<AttachmentResult> {
    return this.impl.resolve(ref)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachment: AttachmentService
  }
}
