// harness 的根 context。与现有 Service 层、Notifier、JobQueue 并存，不替换它们。
// 插件在此挂载；每个插件的注册都是可逆效果，卸载即回滚。
import { Context } from '@deepseek-ai/cordis'
import './events'

let root: Context | null = null

export function bootHarness(): Context {
  if (root) return root
  root = new Context()
  return root
}

export function getHarness(): Context {
  if (!root) throw new Error('harness not booted')
  return root
}
