// harness 的根 context。与现有 Service 层、Notifier、JobQueue 并存，不替换它们。
// 插件在此挂载；每个插件的注册都是可逆效果，卸载即回滚。
import { Context } from '@deepseek-ai/cordis'
import './events'
import { mountHarnessPlugins } from './plugins'
import { ensureSessionEventTable } from './session/sqliteStore'
import { getHorseStore } from './horses'
import { getSetting } from '../services/SettingsService'

let root: Context | null = null

export function bootHarness(): Context {
  if (root) return root
  root = new Context()
  ensureSessionEventTable()
  // 把既有的单一助手迁成马厩里的第一匹。幂等：已经有马就只补默认标记。
  // 沿用用户之前挑过的外观，否则升级之后马会莫名其妙换一副样子。
  const previousSkin = getSetting('stable.horse.default.skin')
  getHorseStore().seed({
    name: 'Veridian',
    skin: typeof previousSkin === 'string' && previousSkin ? previousSkin : 'bay',
  })
  mountHarnessPlugins(root)
  return root
}

export function getHarness(): Context {
  if (!root) throw new Error('harness not booted')
  return root
}
