// Minimal query cache with event-driven invalidation (~React Query in 120
// lines, no dependency). Components declare WHAT data they need via useQuery;
// WHEN to refetch is decided centrally by domain events from the main process.
import { useEffect, useRef, useState } from 'react'
import type { DomainEvent } from '../../../shared/events'

type QueryKey = readonly (string | number)[]

interface CacheEntry {
  data: unknown
  version: number
  listeners: Set<() => void>
}

const cache = new Map<string, CacheEntry>()

function keyOf(key: QueryKey): string {
  return JSON.stringify(key)
}

function entryFor(key: QueryKey): CacheEntry {
  const k = keyOf(key)
  let e = cache.get(k)
  if (!e) {
    e = { data: undefined, version: 0, listeners: new Set() }
    cache.set(k, e)
  }
  return e
}

/** Bump version of every entry whose key starts with the given prefix. */
export function invalidate(prefix: QueryKey): void {
  const prefixStr = keyOf(prefix)
  const prefixOpen = prefixStr.slice(0, -1)  // drop closing ] to prefix-match
  for (const [k, e] of cache) {
    if (k === prefixStr || k.startsWith(prefixOpen + ',')) {
      e.version++
      for (const fn of e.listeners) fn()
    }
  }
}

/** Optimistic update: mutate cached data immediately, roll back on failure. */
export async function mutate<T>(
  key: QueryKey,
  updater: (old: T) => T,
  commit: () => Promise<unknown>
): Promise<void> {
  const e = entryFor(key)
  const before = e.data
  if (e.data !== undefined) {
    e.data = updater(e.data as T)
    e.version++
    for (const fn of e.listeners) fn()
  }
  try {
    await commit()
  } catch (err) {
    e.data = before
    e.version++
    for (const fn of e.listeners) fn()
    throw err
  }
}

export function useQuery<T>(key: QueryKey, fetcher: () => Promise<T>): {
  data: T | undefined
  loading: boolean
  refetch: () => void
} {
  const k = keyOf(key)
  const e = entryFor(key)
  const [, force] = useState(0)
  const [loading, setLoading] = useState(e.data === undefined)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    const entry = entryFor(key)
    const rerender = (): void => force((n) => n + 1)
    entry.listeners.add(rerender)

    let cancelled = false
    let lastFetched = -1

    const load = async (): Promise<void> => {
      const v = entry.version
      if (v === lastFetched) return
      lastFetched = v
      if (entry.data === undefined) setLoading(true)
      try {
        const data = await fetcherRef.current()
        if (!cancelled && entry.version === v) {
          entry.data = data
          rerender()
        }
      } catch (err) {
        console.error('[queryCache] fetch failed for', k, err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const onInvalidate = (): void => { load() }
    entry.listeners.add(onInvalidate)

    return () => {
      cancelled = true
      entry.listeners.delete(rerender)
      entry.listeners.delete(onInvalidate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k])

  return {
    data: e.data as T | undefined,
    loading,
    refetch: () => invalidate(key),
  }
}

// ── Central event -> invalidation wiring ─────────────────────────────────────
// Called once from App. This is the only place that maps domain events to
// cache keys; components never decide when to refresh.

let wired = false

export function wireDomainEvents(onEvent?: (e: DomainEvent) => void): void {
  if (wired || !window.veridian?.onDomainEvent) return
  wired = true
  window.veridian.onDomainEvent((e: DomainEvent) => {
    switch (e.type) {
      case 'item.created':
      case 'item.modified':
      case 'item.trashed':
      case 'item.restored':
      case 'item.deleted':
        invalidate(['items'])
        for (const id of e.ids) invalidate(['item', id])
        break
      case 'attachment.changed':
        for (const id of e.itemIds) invalidate(['attachments', id])
        break
      case 'tag.changed':
        for (const id of e.itemIds) invalidate(['tags', id])
        invalidate(['tags-all'])
        invalidate(['items'])   // inline tag chips in the list
        break
      case 'creator.changed':
        for (const id of e.itemIds) invalidate(['creators', id])
        break
      case 'collection.changed':
        invalidate(['collections'])
        invalidate(['items'])
        break
      case 'settings.changed':
        invalidate(['settings'])
        break
      case 'job.progress':
        break   // handled by the status bar, not the cache
    }
    onEvent?.(e)
  })
}
