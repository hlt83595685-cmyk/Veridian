// Typed data hooks over the query cache. Components use these instead of
// calling window.veridian directly for reads -- refresh is event-driven.
import { useQuery } from './queryCache'
import type { Item, Attachment, Tag, Creator, Collection } from '../../../shared/types'

export function useAttachments(itemId: number): { data: Attachment[]; loading: boolean } {
  const { data, loading } = useQuery<Attachment[]>(
    ['attachments', itemId],
    () => window.veridian.attachments.getByItem(itemId)
  )
  return { data: data ?? [], loading }
}

export function useTags(itemId: number): { data: Tag[]; loading: boolean } {
  const { data, loading } = useQuery<Tag[]>(
    ['tags', itemId],
    () => window.veridian.tags.getByItem(itemId)
  )
  return { data: data ?? [], loading }
}

export function useCreators(itemId: number): { data: Creator[]; loading: boolean } {
  const { data, loading } = useQuery<Creator[]>(
    ['creators', itemId],
    () => window.veridian.creators.getByItem(itemId)
  )
  return { data: data ?? [], loading }
}

export function useItem(id: number): { data: Item | undefined; loading: boolean } {
  return useQuery<Item | undefined>(['item', id], () => window.veridian.items.getById(id))
}

export function useCollections(): { data: Collection[]; loading: boolean } {
  const { data, loading } = useQuery<Collection[]>(
    ['collections'],
    () => window.veridian.collections.getAll()
  )
  return { data: data ?? [], loading }
}
