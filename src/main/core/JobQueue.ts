// Generalized long-task queue replacing the pdf2md-only serial queue.
// Per-type concurrency, retry with exponential backoff, progress via the
// Notifier job.progress event (single channel for all task kinds).
import { randomUUID } from 'crypto'
import { emit } from './Notifier'
import type { JobStatus } from '../../shared/events'

export interface JobContext {
  progress: (message: string, chunk?: string) => void
}

export type JobHandler<P> = (payload: P, ctx: JobContext) => Promise<void>

interface JobTypeConfig {
  concurrency: number
  maxAttempts: number
  handler: JobHandler<unknown>
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

export function registerJobType<P>(
  type: string,
  handler: JobHandler<P>,
  opts: { concurrency?: number; maxAttempts?: number } = {}
): void {
  types.set(type, {
    concurrency: opts.concurrency ?? 1,
    maxAttempts: opts.maxAttempts ?? 1,
    handler: handler as JobHandler<unknown>,
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

function pushStatus(job: Job, state: JobStatus['state'], message: string, chunk?: string): void {
  emit({
    type: 'job.progress',
    job: {
      id: job.id, type: job.type, label: job.label,
      state, message, chunk, pending: pendingOf(job.type),
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
    })
  }
}

async function run(job: Job, cfg: JobTypeConfig): Promise<void> {
  job.attempts++
  const ctx: JobContext = {
    progress: (message, chunk) => pushStatus(job, 'running', message, chunk),
  }
  pushStatus(job, 'running', '处理中...')
  try {
    await cfg.handler(job.payload, ctx)
    pushStatus(job, 'done', '完成')
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[JobQueue] ${job.type} failed (attempt ${job.attempts}):`, err)
    if (job.attempts < cfg.maxAttempts) {
      const backoff = Math.min(30_000, 1000 * 2 ** job.attempts)
      pushStatus(job, 'queued', `失败，${Math.round(backoff / 1000)}s 后重试...`)
      setTimeout(() => { queue.push(job); drain() }, backoff)
    }
    else {
      pushStatus(job, 'error', msg)
    }
  }
}
