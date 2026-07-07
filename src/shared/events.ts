// Domain events -- the single vocabulary shared by main-process subscribers
// (sync engine, indexers) and the renderer query cache. Every write that goes
// through a Service MUST emit one of these; UI refresh is driven entirely by
// this stream, never by manual reloads.

export interface JobStatus {
  id: string
  type: string
  label: string            // human-readable, e.g. the filename being converted
  state: 'queued' | 'running' | 'done' | 'error'
  message: string
  chunk?: string
  pending: number          // jobs still waiting behind this one
}

export type DomainEvent =
  | { type: 'item.created'; ids: number[] }
  | { type: 'item.modified'; ids: number[] }
  | { type: 'item.trashed'; ids: number[] }
  | { type: 'item.restored'; ids: number[] }
  | { type: 'item.deleted'; ids: number[] }
  | { type: 'attachment.changed'; itemIds: number[] }
  | { type: 'tag.changed'; itemIds: number[] }
  | { type: 'collection.changed'; ids: number[] }
  | { type: 'creator.changed'; itemIds: number[] }
  | { type: 'settings.changed'; keys: string[] }
  | { type: 'job.progress'; job: JobStatus }

export type DomainEventType = DomainEvent['type']
