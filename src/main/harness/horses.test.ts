// 跑的是真 SQL，不是 mock。better-sqlite3 按 Electron ABI 编译，纯 node 下加载
// 不了，所以用 node:sqlite —— 它和 better-sqlite3 的 exec/prepare 形状一致。
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { makeHorseStore, type HorseDb, type HorseStore } from './horses'

let store: HorseStore

beforeEach(() => {
  store = makeHorseStore(new DatabaseSync(':memory:') as unknown as HorseDb)
})

describe('horse store', () => {
  it('makes the first horse the default', () => {
    const a = store.create({ name: 'Veridian', skin: 'bay' })
    expect(a.isDefault).toBe(true)
    expect(store.getDefault()?.id).toBe(a.id)
  })

  it('does not hand the default to later horses', () => {
    const a = store.create({ name: 'A', skin: 'bay' })
    const b = store.create({ name: 'B', skin: 'pony' })
    expect(b.isDefault).toBe(false)
    expect(store.getDefault()?.id).toBe(a.id)
  })

  it('keeps exactly one default when it moves', () => {
    store.create({ name: 'A', skin: 'bay' })
    const b = store.create({ name: 'B', skin: 'pony' })
    store.setDefault(b.id)
    expect(store.list().filter((h) => h.isDefault).map((h) => h.name)).toEqual(['B'])
  })

  it('defaults a new horse to the lowest ceiling', () => {
    expect(store.create({ name: 'A', skin: 'bay' }).ceiling).toBe('read')
  })

  it('stores an explicit ceiling', () => {
    const h = store.create({ name: 'Groom', skin: 'draft', ceiling: 'write-library' })
    expect(store.get(h.id)?.ceiling).toBe('write-library')
  })

  // 权限只能被明确写入，不能被脏数据抬高。
  it('downgrades an unrecognised ceiling to read rather than trusting it', () => {
    const h = store.create({ name: 'A', skin: 'bay' })
    const db = new DatabaseSync(':memory:') as unknown as HorseDb
    const s2 = makeHorseStore(db)
    const made = s2.create({ name: 'B', skin: 'bay' })
    db.prepare('UPDATE horses SET ceiling = ? WHERE id = ?').run('root', made.id)
    expect(s2.get(made.id)?.ceiling).toBe('read')
    expect(h.ceiling).toBe('read')
  })

  it('trims and caps the name', () => {
    const h = store.create({ name: '  ' + 'x'.repeat(80) + '  ', skin: 'bay' })
    expect(h.name.length).toBe(40)
  })

  it('rejects an empty name', () => {
    expect(() => store.create({ name: '   ', skin: 'bay' })).toThrow()
  })

  it('updates only the fields given', () => {
    const h = store.create({ name: 'A', skin: 'bay', ceiling: 'write-library' })
    store.update(h.id, { name: 'Scout' })
    const after = store.get(h.id)!
    expect(after.name).toBe('Scout')
    expect(after.skin).toBe('bay')
    expect(after.ceiling).toBe('write-library')
  })

  // 空马厩 = 没有助手能回答，那是死机不是配置。
  it('refuses to delete the last horse', () => {
    const a = store.create({ name: 'A', skin: 'bay' })
    store.remove(a.id)
    expect(store.list()).toHaveLength(1)
  })

  it('promotes another horse when the default is deleted', () => {
    const a = store.create({ name: 'A', skin: 'bay' })
    const b = store.create({ name: 'B', skin: 'pony' })
    store.remove(a.id)
    expect(store.list()).toHaveLength(1)
    expect(store.getDefault()?.id).toBe(b.id)
    expect(store.get(b.id)?.isDefault).toBe(true)
  })

  it('seeds one horse on an empty stable and is idempotent', () => {
    store.seed({ name: 'Veridian', skin: 'bay' })
    store.seed({ name: 'Veridian', skin: 'bay' })
    expect(store.list()).toHaveLength(1)
    expect(store.getDefault()?.name).toBe('Veridian')
  })

  // 直接把 is_default 全清掉，模拟数据被外部改坏，再验证 seed 能修回来。
  it('repairs a stable that somehow lost its default', () => {
    const db = new DatabaseSync(':memory:') as unknown as HorseDb
    const s = makeHorseStore(db)
    s.create({ name: 'A', skin: 'bay' })
    s.create({ name: 'B', skin: 'pony' })

    db.prepare('UPDATE horses SET is_default = 0').run()
    expect(s.list().filter((h) => h.isDefault)).toHaveLength(0)

    s.seed({ name: 'ignored', skin: 'bay' })
    expect(s.list()).toHaveLength(2) // 没有多造一匹
    expect(s.list().filter((h) => h.isDefault).map((h) => h.name)).toEqual(['A'])
  })

  // 即使标记全丢了，getDefault 也不能返回 null 让调用方崩。
  it('falls back to the first horse when no default is marked', () => {
    const db = new DatabaseSync(':memory:') as unknown as HorseDb
    const s = makeHorseStore(db)
    s.create({ name: 'A', skin: 'bay' })
    s.create({ name: 'B', skin: 'pony' })
    db.prepare('UPDATE horses SET is_default = 0').run()
    expect(s.getDefault()?.name).toBe('A')
  })

  it('ignores writes to a horse that does not exist', () => {
    expect(() => store.update('nope', { name: 'x' })).not.toThrow()
    expect(() => store.setDefault('nope')).not.toThrow()
    expect(() => store.remove('nope')).not.toThrow()
  })
})

// ── 装配的工具清单 ──────────────────────────────────────────────────────────
describe('horse tools（装配清单）', () => {
  it('用户建的马默认什么都没勾——白名单', () => {
    expect(store.create({ name: 'A', skin: 'bay' }).tools).toEqual([])
  })

  it('给了就存下来，顺序按用户给的，不擅自排序', () => {
    const h = store.create({ name: 'A', skin: 'bay', tools: ['search_library', 'get_item_info'] })
    expect(h.tools).toEqual(['search_library', 'get_item_info'])
    expect(store.get(h.id)?.tools).toEqual(['search_library', 'get_item_info'])
  })

  it('入库前去重、去空白', () => {
    const h = store.create({ name: 'A', skin: 'bay', tools: ['a', ' a ', '', '  ', 'b'] })
    expect(h.tools).toEqual(['a', 'b'])
  })

  it('可以改，也可以全部取消勾选', () => {
    const h = store.create({ name: 'A', skin: 'bay', tools: ['a', 'b'] })
    store.update(h.id, { tools: ['c'] })
    expect(store.get(h.id)?.tools).toEqual(['c'])
    // 空数组是「全取消」，不是「没传」——用 ?? 合并会让人永远取消不掉最后一个
    store.update(h.id, { tools: [] })
    expect(store.get(h.id)?.tools).toEqual([])
  })

  it('不传 tools 的 update 不动清单', () => {
    const h = store.create({ name: 'A', skin: 'bay', tools: ['a'] })
    store.update(h.id, { name: 'B' })
    const after = store.get(h.id)
    expect(after?.name).toBe('B')
    expect(after?.tools).toEqual(['a'])
  })

  it('内建的第一匹马开箱可用，用户之后建的不是', () => {
    store.seed({ name: 'Veridian', skin: 'bay' })
    expect(store.getDefault()?.tools.length).toBeGreaterThan(0)
    expect(store.create({ name: 'Mine', skin: 'pony' }).tools).toEqual([])
  })
})

describe('tools 列的脏数据', () => {
  const raw = (json: string): string[] => {
    const db = new DatabaseSync(':memory:') as unknown as HorseDb
    const s = makeHorseStore(db)
    const h = s.create({ name: 'A', skin: 'bay' })
    db.prepare('UPDATE horses SET tools = ? WHERE id = ?').run(json, h.id)
    return s.get(h.id)?.tools ?? ['<horse missing>']
  }

  it.each([
    ['不是 JSON', 'not json'],
    ['不是数组', '{"a":1}'],
    ['空串', ''],
  ])('%s → 退回空清单，不抛', (_label, json) => {
    expect(raw(json)).toEqual([])
  })

  it('数组里混了非字符串就把它们丢掉，留下能用的', () => {
    expect(raw('["a", 1, null, {"x":1}, "b", "a"]')).toEqual(['a', 'b'])
  })
})

describe('老库迁移', () => {
  it('补列时把既有的马补成迁移快照，而不是清空它们的能力', () => {
    const db = new DatabaseSync(':memory:') as unknown as HorseDb
    // 手工造一张「加 tools 列之前」的表
    db.exec(`
      CREATE TABLE horses (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, skin TEXT NOT NULL,
        ceiling TEXT NOT NULL DEFAULT 'read',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
    db.prepare('INSERT INTO horses (id, name, skin, is_default) VALUES (?, ?, ?, ?)')
      .run('old-1', 'Veridian', 'bay', 1)

    const s = makeHorseStore(db)
    const old = s.get('old-1')
    expect(old?.tools).toContain('search_library')
    expect(old?.tools).toContain('get_item_info')

    // 迁移之后新建的马仍然是空的——白名单只对「之后冒出来的工具」生效
    expect(s.create({ name: 'New', skin: 'pony' }).tools).toEqual([])
  })

  it('迁移可重复执行，不会重复补列或覆盖用户的选择', () => {
    const db = new DatabaseSync(':memory:') as unknown as HorseDb
    const s1 = makeHorseStore(db)
    const h = s1.create({ name: 'A', skin: 'bay', tools: ['only_this'] })
    // 再建一次 store（等于再启动一次 app）
    const s2 = makeHorseStore(db)
    expect(s2.get(h.id)?.tools).toEqual(['only_this'])
  })
})
