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

export interface ItemImages {
  dir: string
  label: string
  files: string[]
}

// Resolves the item's imagedir attachment (if any) and lists its files.
// Event-driven like the other hooks here: attachment.changed (e.g. a pdf2md
// conversion registering the imagedir once it finishes) and
// workspace.dataRefreshed (a sync/pull, or switching workspaces) both
// invalidate this query centrally in queryCache.ts, so callers never need to
// poll or manually refetch after those events.
export function useItemImages(itemId: number): { data: ItemImages | null; loading: boolean } {
  const { data, loading } = useQuery<ItemImages | null>(
    ['item-images', itemId],
    async () => {
      const attachments = await window.veridian.attachments.getByItem(itemId)
      const imgDir = attachments.find((a) => a.type === 'imagedir')
      if (!imgDir?.path) return null
      const files = await window.veridian.fs.listDir(imgDir.path)
      return { dir: imgDir.path, label: imgDir.filename ?? '图片文件夹', files }
    }
  )
  return { data: data ?? null, loading }
}
