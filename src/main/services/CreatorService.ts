import { getCreatorsByItem, setCreatorsForItem as repoSet, type ItemCreator } from '../db/creators'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export function listByItem(itemId: number): ItemCreator[] {
  return getCreatorsByItem(itemId)
}

export function setCreatorsForItem(itemId: number, creators: ItemCreator[]): void {
  repoSet(itemId, creators)
  appendOp('item', itemId, 'modify', { creators: creators.length })
  emit({ type: 'creator.changed', itemIds: [itemId] })
}
