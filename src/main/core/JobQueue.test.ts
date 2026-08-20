import { describe, it, expect, vi } from 'vitest'

// Notifier pulls in electron's BrowserWindow; the queue's progress events are
// irrelevant here, so stub the whole module.
vi.mock('./Notifier', () => ({ emit: () => {} }))

import { registerJobType, enqueue, isBusy } from './JobQueue'

// The queue keeps module-level state, so every test registers its own job type
// name to stay isolated from the others.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('JobQueue idle signalling', () => {
  it('fires onIdle once after a batch completes', async () => {
    const onIdle = vi.fn()
    registerJobType<number>('t.ok', async () => {}, { concurrency: 1, onIdle })

    enqueue('t.ok', 'a', 1)
    enqueue('t.ok', 'b', 2)
    await flush()

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(isBusy('t.ok')).toBe(false)
  })

  it('still fires onIdle when a job throws (idle signal never wedges)', async () => {
    const onIdle = vi.fn()
    registerJobType<number>('t.throw', async (n) => {
      if (n === 1) throw new Error('boom')
    }, { concurrency: 1, maxAttempts: 1, onIdle })

    enqueue('t.throw', 'bad', 1)
    enqueue('t.throw', 'good', 2)
    await flush()

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(isBusy('t.throw')).toBe(false)
  })

  it('stays busy while a failed job waits for its retry backoff', async () => {
    registerJobType<number>('t.retry', async () => { throw new Error('boom') },
      { concurrency: 1, maxAttempts: 2 })

    enqueue('t.retry', 'r', 1)
    await flush()

    // First attempt failed; the retry is sitting in its backoff timer. Neither
    // running nor queued -- but the type is NOT idle.
    expect(isBusy('t.retry')).toBe(true)
  })
})
