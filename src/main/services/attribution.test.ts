import { describe, it, expect, beforeEach } from 'vitest'
import { getAttribution, setAttribution } from './attribution'

describe('attribution holder', () => {
  beforeEach(() => setAttribution(null))

  it('defaults to null', () => {
    expect(getAttribution()).toBeNull()
  })

  it('round-trips a login', () => {
    setAttribution('octocat')
    expect(getAttribution()).toBe('octocat')
  })

  it('can be cleared back to null', () => {
    setAttribution('octocat')
    setAttribution(null)
    expect(getAttribution()).toBeNull()
  })
})
