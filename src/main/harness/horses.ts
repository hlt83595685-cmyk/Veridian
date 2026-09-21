// 马的存储。一匹马就是一个 agent。
//
// 库是**全局**的，不按工作空间分：一匹马是「我的助手」，不是「这个文库的助
// 手」。切换文库不该让你的助手消失。
//
// 依赖注入而非直接抓 getKnowledgeDb()：better-sqlite3 是按 Electron 的 ABI 编
// 译的，纯 node 下 require 会失败，测试也就只能跳过。传入 db 之后，测试可以用
// node:sqlite 跑真实的 SQL，而不是对着 mock 断言。
import { randomUUID } from 'crypto'
import { getKnowledgeDb } from '../knowledge/db'
import { HORSE_NAME_MAX, type Horse, type ToolKind } from '../../shared/types'

/** better-sqlite3 与 node:sqlite 的公共子集。 */
export interface HorseDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

interface Row {
  id: string
  name: string
  skin: string
  ceiling: string
  tools: string | null
  is_default: number
  created_at: number
}

const CEILINGS: ToolKind[] = ['read', 'write-library', 'write-fs', 'destructive']

/**
 * 迁移时给既有的马补上的工具集。
 *
 * 这是一份**冻结的历史快照**，不是「当前注册了什么」——迁移必须可重放，读实时
 * 注册表会让同一次迁移在不同版本下产生不同结果。
 *
 * 补而不是留空：这些马在加这个字段之前本来就能用这三个工具，保住它们已有的能
 * 力不叫「自动授予新能力」。白名单管的是**之后**冒出来的工具。
 */
const TOOLS_AT_MIGRATION = ['get_item_info', 'search_library', 'load_skill']

/** 库里存的是 JSON 文本，可能是脏的（手改、旧版本、写坏）。解析永不抛。 */
function parseTools(raw: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const v of parsed) {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 入库前归一：去重、丢掉空串与非字符串。顺序保留用户给的那个，不擅自排序。 */
function normalizeTools(tools: readonly string[]): string[] {
  const out: string[] = []
  for (const v of tools) {
    const t = typeof v === 'string' ? v.trim() : ''
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function toHorse(r: Row): Horse {
  return {
    id: r.id,
    name: r.name,
    skin: r.skin,
    // 库里存的是字符串；不认识的值一律降级为最低权限，绝不向上取整。
    ceiling: CEILINGS.includes(r.ceiling as ToolKind) ? (r.ceiling as ToolKind) : 'read',
    tools: parseTools(r.tools),
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
  }
}

export function ensureHorseTable(db: HorseDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS horses (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      skin       TEXT NOT NULL,
      ceiling    TEXT NOT NULL DEFAULT 'read',
      tools      TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  // 老库要补列。列默认是 '[]'（严格白名单），但**已经存在**的行补成迁移快照，
  // 否则升级会让用户的马悄悄失去它本来就有的能力。
  const cols = db.prepare('PRAGMA table_info(horses)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'tools')) {
    db.exec("ALTER TABLE horses ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'")
    db.prepare('UPDATE horses SET tools = ?').run(JSON.stringify(TOOLS_AT_MIGRATION))
  }
}

export interface HorseStore {
  list(): Horse[]
  get(id: string): Horse | null
  getDefault(): Horse | null
  /** 不给 `tools` 就是空的。界面可以预勾一份让人看得见的默认，但模型层不替
   *  用户做主——那正是白名单的意思。 */
  create(input: { name: string; skin: string; ceiling?: ToolKind; tools?: string[] }): Horse
  update(id: string, patch: Partial<Pick<Horse, 'name' | 'skin' | 'ceiling' | 'tools'>>): void
  setDefault(id: string): void
  remove(id: string): void
  /** 确保至少有一匹马，且恰好一匹是默认。首次运行时用来把既有的单一助手迁进来。 */
  seed(input: { name: string; skin: string }): void
}

function cleanName(name: string): string {
  const n = name.trim().slice(0, HORSE_NAME_MAX)
  if (!n) throw new Error('horse name must not be empty')
  return n
}

export function makeHorseStore(db: HorseDb): HorseStore {
  ensureHorseTable(db)

  // 按 rowid 排 = 插入顺序，且天然唯一。用 created_at 排会在同一秒内创建的
  // 马之间退化成按随机 uuid 比大小，马厩顺序和「第一匹是谁」都会变得不确定。
  const all = (): Row[] =>
    db.prepare('SELECT * FROM horses ORDER BY rowid').all() as Row[]

  const store: HorseStore = {
    list: () => all().map(toHorse),

    get(id) {
      const r = db.prepare('SELECT * FROM horses WHERE id = ?').get(id) as Row | undefined
      return r ? toHorse(r) : null
    },

    getDefault() {
      const r = db.prepare('SELECT * FROM horses WHERE is_default = 1 LIMIT 1').get() as
        | Row
        | undefined
      // 没有标记默认的（数据被外部改坏）就退回第一匹，而不是返回 null 让调用方崩。
      return r ? toHorse(r) : (all()[0] ? toHorse(all()[0]) : null)
    },

    create({ name, skin, ceiling = 'read', tools = [] }) {
      const id = randomUUID()
      const first = all().length === 0
      db.prepare(
        'INSERT INTO horses (id, name, skin, ceiling, tools, is_default, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id, cleanName(name), skin, ceiling,
        JSON.stringify(normalizeTools(tools)),
        first ? 1 : 0, Math.floor(Date.now() / 1000),
      )
      return store.get(id) as Horse
    },

    update(id, patch) {
      const current = store.get(id)
      if (!current) return
      db.prepare('UPDATE horses SET name = ?, skin = ?, ceiling = ?, tools = ? WHERE id = ?').run(
        patch.name !== undefined ? cleanName(patch.name) : current.name,
        patch.skin ?? current.skin,
        patch.ceiling ?? current.ceiling,
        // 空数组是合法的取消勾选，不能被 ?? 当成「没传」——这里必须显式判断。
        JSON.stringify(patch.tools !== undefined ? normalizeTools(patch.tools) : current.tools),
        id,
      )
    },

    setDefault(id) {
      if (!store.get(id)) return
      db.prepare('UPDATE horses SET is_default = 0').run()
      db.prepare('UPDATE horses SET is_default = 1 WHERE id = ?').run(id)
    },

    remove(id) {
      const rows = all()
      // 最后一匹不能删：一个空马厩意味着没有助手能回答，那是死机不是配置。
      if (rows.length <= 1) return
      const target = rows.find((r) => r.id === id)
      if (!target) return
      db.prepare('DELETE FROM horses WHERE id = ?').run(id)
      // 删掉默认马之后必须立刻另立一匹，否则 getDefault 会落到兜底分支。
      if (target.is_default === 1) {
        const next = all()[0]
        if (next) store.setDefault(next.id)
      }
    },

    seed({ name, skin }) {
      const rows = all()
      if (rows.length === 0) {
        // 内建的第一匹马必须开箱可用——它是「默认助手」，不是用户建的马。
        // 用户之后自己建的马才从空白开始。
        store.create({ name, skin, tools: TOOLS_AT_MIGRATION })
        return
      }
      if (!rows.some((r) => r.is_default === 1)) store.setDefault(rows[0].id)
    },
  }

  return store
}

// ── 生产实例 ────────────────────────────────────────────────────────────────
// 惰性创建：getKnowledgeDb() 在主进程启动早期还不可用。


let production: HorseStore | null = null

export function getHorseStore(): HorseStore {
  if (!production) production = makeHorseStore(getKnowledgeDb() as unknown as HorseDb)
  return production
}

/** 仅供测试重置。 */
export function _resetHorseStore(): void {
  production = null
}
