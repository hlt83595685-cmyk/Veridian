import { linkItems as repoLink, unlink as repoUnlink, listRelationsForItem } from '../db/relations'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export { listRelationsForItem }

/** Returns false if the edge already existed. */
export function linkItems(srcItemId: number, dstItemId: number, relType: string, origin: 'user' | 'ai'): boolean {
	const created = repoLink(srcItemId, dstItemId, relType, origin)
	if (created) {
		appendOp('relation', srcItemId, 'create', { dst: dstItemId, relType, origin })
		emit({ type: 'relation.changed', itemIds: [srcItemId, dstItemId] })
	}
	return created
}

export function unlink(srcItemId: number, dstItemId: number, relType: string): void {
	repoUnlink(srcItemId, dstItemId, relType)
	emit({ type: 'relation.changed', itemIds: [srcItemId, dstItemId] })
}
