// IPC gateway: registers every channel declared in shared/ipc-contract.ts.
// Incoming args are zod-validated before the handler runs; results and errors
// are wrapped in a uniform envelope that the preload bridge unwraps, so
// renderer call sites keep their plain-value API.
import { IpcMain } from 'electron'
import { contract, type IpcChannel } from '../../shared/ipc-contract'
import { handlers } from './handlers'

export interface IpcEnvelope {
  ok: boolean
  data?: unknown
  error?: string
}

function toPublicError(err: unknown): string {
  // Never leak stack traces or internal paths beyond the message
  if (err instanceof Error) return err.message
  return String(err)
}

export function registerIpcGateway(ipcMain: IpcMain): void {
  for (const channel of Object.keys(contract) as IpcChannel[]) {
    const schema = contract[channel]
    const handler = handlers[channel]
    ipcMain.handle(channel, async (event, ...raw): Promise<IpcEnvelope> => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        console.warn(`[ipc] rejected ${channel}:`, parsed.error.issues[0]?.message)
        return { ok: false, error: `Invalid arguments for ${channel}` }
      }
      try {
        const data = await handler(event, ...(parsed.data as never[]))
        return { ok: true, data }
      } catch (err) {
        console.error(`[ipc] ${channel} failed:`, err)
        return { ok: false, error: toPublicError(err) }
      }
    })
  }
  console.log(`[ipc] gateway registered ${Object.keys(contract).length} channels`)
}
