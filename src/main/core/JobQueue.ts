// Generalized long-task queue replacing the pdf2md-only serial queue.
// Per-type concurrency, retry with exponential backoff, progress via the
// Notifier job.progress event (single channel for all task kinds).
import { randomUUID } from 'crypto'
import { emit } from './Notifier'
import type { JobStatus } from '../../shared/events'

export interface JobContext {
  progress: (message: string, chunk?: string, percent?: number) => void
}

export type JobHandler<P> = (payload: P, ctx: JobContext) => Promise<void>

interface JobTypeConfig {
  concurrency: number
  maxAttempts: number
  handler: JobHandler<unknown>
  onIdle?: () => void
}

interface Job {
  id: string
  type: string
  label: string
  payload: unknown
  attempts: number
}

const types = new Map<string, JobTypeConfig>()
const queue: Job[] = []
const running = new Map<string, number>()  // type -> active count
const retrying = new Map<string, number>()  // type -> jobs waiting out a backoff

export function registerJobType<P>(
  type: string,
  handler: JobHandler<P>,
  opts: { concurrency?: number; maxAttempts?: number; onIdle?: () => void } = {}
): void {
  types.set(type, {
    concurrency: opts.concurrency ?? 1,
    maxAttempts: opts.maxAttempts ?? 1,
    handler: handler as JobHandler<unknown>,
    onIdle: opts.onIdle,
  })
}

export function enqueue<P>(type: string, label: string, payload: P): string {
  if (!types.has(type)) throw new Error(`Unknown job type: ${type}`)
  const job: Job = { id: randomUUID(), type, label, payload, attempts: 0 }
  queue.push(job)
  pushStatus(job, 'queued', '排队中...')
  drain()
  return job.id
}

function pendingOf(type: string): number {
  return queue.filter((j) => j.type === type).length
}

/**
 * Is this job type still working? True while anything is running, queued, or
 * waiting out a retry backoff. Derived from the queue's own bookkeeping, which
 * settles every job exactly once even when its handler throws -- callers get an
 * idle signal that cannot wedge.
 */
export function isBusy(type: string): boolean {
  return (running.get(type) ?? 0) > 0 || pendingOf(type) > 0 || (retrying.get(type) ?? 0) > 0
}

function pushStatus(
  job: Job, state: JobStatus['state'], message: string, chunk?: string, progress?: number
): void {
  emit({
    type: 'job.progress',
    job: {
      id: job.id, type: job.type, label: job.label,
      state, message, chunk, pending: pendingOf(job.type), progress,
    },
  })
}

function drain(): void {
  for (let i = 0; i < queue.length; ) {
    const job = queue[i]
    const cfg = types.get(job.type)!
    const active = running.get(job.type) ?? 0
    if (active >= cfg.concurrency) { i++; continue }

    queue.splice(i, 1)
    running.set(job.type, active + 1)
    run(job, cfg).finally(() => {
      running.set(job.type, (running.get(job.type) ?? 1) - 1)
      drain()
      if (!isBusy(job.type)) cfg.onIdle?.()
    })
  }
}

async function run(job: Job, cfg: JobTypeConfig): Promise<void> {
  job.attempts++
  const ctx: JobContext = {
    progress: (message, chunk, percent) => pushStatus(job, 'running', message, chunk, percent),
  }
  pushStatus(job, 'running', '处理中...')
  try {
    await cfg.handler(job.payload, ctx)
    pushStatus(job, 'done', '完成', undefined, 1)
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[JobQueue] ${job.type} failed (attempt ${job.attempts}):`, err)
    if (job.attempts < cfg.maxAttempts) {
      const backoff = Math.min(30_000, 1000 * 2 ** job.attempts)
      pushStatus(job, 'queued', `失败，${Math.round(backoff / 1000)}s 后重试...`)
      retrying.set(job.type, (retrying.get(job.type) ?? 0) + 1)
      setTimeout(() => {
        retrying.set(job.type, (retrying.get(job.type) ?? 1) - 1)
        queue.push(job)
        drain()
      }, backoff)
    }
    else {
      pushStatus(job, 'error', msg)
    }
  }
}
