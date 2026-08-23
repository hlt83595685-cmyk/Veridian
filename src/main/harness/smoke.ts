// 临时文件：验证 cordis 能在主进程被打包并运行。Task 2 完成后删除。
import { Context } from '@deepseek-ai/cordis'

export function cordisSmoke(): string {
  const ctx = new Context()
  return typeof ctx.plugin === 'function' ? 'cordis-ok' : 'cordis-broken'
}
