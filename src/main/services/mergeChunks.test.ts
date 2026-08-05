import { describe, it, expect } from 'vitest'
import { planChunkMerge } from './mergeChunks'

describe('planChunkMerge', () => {
	it('namespaces each chunk\'s images with c{i}_ and rewrites refs', () => {
		const { content, copies } = planChunkMerge([
			{ md: '![](images/img_0.jpg)', images: ['img_0.jpg'] },
			{ md: '![](images/img_0.jpg) ![](images/pic.png)', images: ['img_0.jpg', 'pic.png'] },
		])
		expect(content).toContain('images/c1_img_0.jpg')
		expect(content).toContain('images/c2_img_0.jpg')
		expect(content).toContain('images/c2_pic.png')
		expect(copies).toEqual([
			{ chunk: 0, from: 'img_0.jpg', to: 'c1_img_0.jpg' },
			{ chunk: 1, from: 'img_0.jpg', to: 'c2_img_0.jpg' },
			{ chunk: 1, from: 'pic.png', to: 'c2_pic.png' },
		])
	})

	it('joins chunk markdown with a horizontal-rule separator', () => {
		const { content } = planChunkMerge([
			{ md: 'first', images: [] },
			{ md: 'second', images: [] },
		])
		expect(content).toBe('first\n\n---\n\nsecond')
	})

	it('reuses one target and one copy for an image referenced twice in a chunk', () => {
		const { content, copies } = planChunkMerge([
			{ md: '![](images/x.png) then ![](images/x.png)', images: ['x.png'] },
		])
		expect(copies).toEqual([{ chunk: 0, from: 'x.png', to: 'c1_x.png' }])
		expect(content.match(/c1_x\.png/g)).toHaveLength(2)
	})

	it('handles html img tags', () => {
		const { content, copies } = planChunkMerge([
			{ md: '<img src="images/photo.jpeg" alt="p">', images: ['photo.jpeg'] },
		])
		expect(content).toContain('src="images/c1_photo.jpeg"')
		expect(copies).toEqual([{ chunk: 0, from: 'photo.jpeg', to: 'c1_photo.jpeg' }])
	})

	it('leaves external and unknown refs untouched and does not copy them', () => {
		const { content, copies } = planChunkMerge([
			{ md: '![](https://ex.com/a.png) ![](images/gone.png) ![](images/here.png)', images: ['here.png'] },
		])
		expect(content).toContain('https://ex.com/a.png')
		expect(content).toContain('images/gone.png')
		expect(content).toContain('images/c1_here.png')
		expect(copies).toEqual([{ chunk: 0, from: 'here.png', to: 'c1_here.png' }])
	})

	it('emits no copies when a chunk has no images', () => {
		const { copies } = planChunkMerge([{ md: 'text only', images: [] }])
		expect(copies).toEqual([])
	})
})
