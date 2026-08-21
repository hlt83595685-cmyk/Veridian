import { describe, it, expect } from 'vitest'
import { classifyStagingFile } from './StorageGC'

describe('classifyStagingFile', () => {
  it('marks MinerU intermediates as debris', () => {
    expect(classifyStagingFile('abc_origin.pdf')).toBe('debris')
    expect(classifyStagingFile('layout.json')).toBe('debris')
    expect(classifyStagingFile('abc_model.json')).toBe('debris')
    expect(classifyStagingFile('abc_content_list.json')).toBe('debris')
    expect(classifyStagingFile('abc_content_list_v2.json')).toBe('debris')
  })
  it('marks the conversion product as worth keeping', () => {
    expect(classifyStagingFile('full.md')).toBe('product')
    expect(classifyStagingFile('Full.md')).toBe('product')
    expect(classifyStagingFile('images')).toBe('product')
  })
  it('keeps anything it does not recognise', () => {
    expect(classifyStagingFile('mystery.dat')).toBe('product')
  })
})
