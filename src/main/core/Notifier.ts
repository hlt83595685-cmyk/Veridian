// Event bus modelled after Zotero.Notifier: every Service write emits a
// DomainEvent here; in-process subscribers (future sync engine, indexers) and
// the renderer (via a single 'domain-event' push channel) all consume the same
// stream. This is the only mechanism by which the UI learns about data changes.
import { BrowserWindow } from 'electron'
import type { DomainEvent } from '../../shared/events'

type Subscriber = (e: DomainEvent) => void

const subscribers = new Set<Subscriber>()

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function emit(e: DomainEvent): void {
  for (const fn of subscribers) {
    try { fn(e) }
    catch (err) { console.error('[Notifier] subscriber threw:', err) }
  }
  // Broadcast to every window so future multi-window UIs stay in sync for free
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('domain-event', e)
  }
}
