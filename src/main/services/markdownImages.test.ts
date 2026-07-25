import { describe, it, expect } from 'vitest'
import { planImageRenames } from './markdownImages'

describe('planImageRenames', () => {
  it('renames referenced images to figN in order of first appearance', () => {
    const md = '![a](images/abc123.jpg)\n\ntext\n\n![b](images/def456.png)'
    const { content, renames } = planImageRenames(md, ['abc123.jpg', 'def456.png'])
    expect(content).toContain('images/fig1.jpg')
    expect(content).toContain('images/fig2.png')
    expect(renames).toEqual([
      { from: 'abc123.jpg', to: 'fig1.jpg' },
      { from: 'def456.png', to: 'fig2.png' },
    ])
  })

  it('reuses the same fig name for repeated references', () => {
    const md = '![](images/x.png) and again ![](images/x.png)'
    const { content, renames } = planImageRenames(md, ['x.png'])
    expect(renames).toEqual([{ from: 'x.png', to: 'fig1.png' }])
    expect(content.match(/fig1\.png/g)).toHaveLength(2)
    expect(content).not.toContain('x.png')
  })

  it('handles html img tags', () => {
    const md = '<img src="images/photo.jpeg" alt="p">'
    const { content, renames } = planImageRenames(md, ['photo.jpeg'])
    expect(content).toContain('src="images/fig1.jpeg"')
    expect(renames).toEqual([{ from: 'photo.jpeg', to: 'fig1.jpeg' }])
  })

  it('leaves references to missing files untouched', () => {
    const md = '![](images/gone.png) ![](images/here.png)'
    const { content, renames } = planImageRenames(md, ['here.png'])
    expect(content).toContain('images/gone.png')   // untouched
    expect(content).toContain('images/fig1.png')   // here.png renamed
    expect(renames).toEqual([{ from: 'here.png', to: 'fig1.png' }])
  })

  it('ignores http and data urls', () => {
    const md = '![](https://example.com/a.png) ![](data:image/png;base64,xx) ![](images/local.png)'
    const { content, renames } = planImageRenames(md, ['local.png', 'a.png'])
    expect(content).toContain('https://example.com/a.png')
    expect(content).toContain('data:image/png;base64,xx')
    expect(renames).toEqual([{ from: 'local.png', to: 'fig1.png' }])
  })

  it('normalizes refs with different path prefixes to images/', () => {
    const md = '![](./images/deep.png) ![](bare.png)'
    const { content } = planImageRenames(md, ['deep.png', 'bare.png'])
    expect(content).toContain('](images/fig1.png)')
    expect(content).toContain('](images/fig2.png)')
  })

  it('is a no-op for markdown without image refs', () => {
    const md = '# Title\n\nplain text'
    const { content, renames } = planImageRenames(md, ['unused.png'])
    expect(content).toBe(md)
    expect(renames).toEqual([])
  })

  it('avoids collisions when a source is already named like a target', () => {
    // first-appearing image should become fig1 even though a file named
    // fig1.png exists and is referenced later
    const md = '![](images/a.png) ![](images/fig1.png)'
    const { renames } = planImageRenames(md, ['a.png', 'fig1.png'])
    expect(renames).toEqual([
      { from: 'a.png', to: 'fig1.png' },
      { from: 'fig1.png', to: 'fig2.png' },
    ])
  })

  it('reports images that are never referenced', () => {
    const md = '![](images/used.png)'
    const { unreferenced } = planImageRenames(md, ['used.png', 'orphan1.png', 'orphan2.jpg'])
    expect(unreferenced.sort()).toEqual(['orphan1.png', 'orphan2.jpg'])
  })

  it('unreferenced is empty when all provided images are referenced', () => {
    const md = '![](images/a.png) ![](images/b.png)'
    const { unreferenced } = planImageRenames(md, ['a.png', 'b.png'])
    expect(unreferenced).toEqual([])
  })

  it('does not count a missing referenced file as making an unrelated image referenced', () => {
    // md references gone.png (not on disk) and here.png (on disk); orphan.png
    // is on disk but never referenced -- must still be reported as unreferenced
    const md = '![](images/gone.png) ![](images/here.png)'
    const { unreferenced } = planImageRenames(md, ['here.png', 'orphan.png'])
    expect(unreferenced).toEqual(['orphan.png'])
  })
})
