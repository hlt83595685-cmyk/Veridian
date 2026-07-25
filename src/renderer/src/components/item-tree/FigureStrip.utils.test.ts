import { describe, it, expect } from 'vitest'
import { sortByFigNumber } from './FigureStrip.utils'

describe('sortByFigNumber', () => {
  it('sorts fig1..fig10 numerically, not lexicographically', () => {
    const paths = [
      'C:/repo/images/fig10.png',
      'C:/repo/images/fig2.png',
      'C:/repo/images/fig1.jpg',
    ]
    expect(sortByFigNumber(paths)).toEqual([
      'C:/repo/images/fig1.jpg',
      'C:/repo/images/fig2.png',
      'C:/repo/images/fig10.png',
    ])
  })

  it('handles forward and back slashes in paths', () => {
    const paths = ['a\\images\\fig2.png', 'a\\images\\fig1.png']
    expect(sortByFigNumber(paths)).toEqual(['a\\images\\fig1.png', 'a\\images\\fig2.png'])
  })

  it('puts non-figN-named files after numbered ones, preserving relative order', () => {
    const paths = ['x/cover.png', 'x/fig2.png', 'x/fig1.png', 'x/misc.jpg']
    expect(sortByFigNumber(paths)).toEqual(['x/fig1.png', 'x/fig2.png', 'x/cover.png', 'x/misc.jpg'])
  })

  it('does not mutate the input array', () => {
    const paths = ['a/fig2.png', 'a/fig1.png']
    const copy = [...paths]
    sortByFigNumber(paths)
    expect(paths).toEqual(copy)
  })

  it('returns an empty array for empty input', () => {
    expect(sortByFigNumber([])).toEqual([])
  })
})
