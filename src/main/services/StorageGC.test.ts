import { describe, it, expect, vi } from 'vitest'
import { classifyStagingFile, isItemDirName } from './StorageGC'
import { convertedDir } from './ConversionService'

vi.mock('electron', () => ({ app: { getPath: () => '/userData' } }))

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

describe('convertedDir', () => {
  it('gives each library its own converted folder so item ids cannot collide', () => {
    expect(convertedDir('personal', 7)).not.toBe(convertedDir('ws3', 7))
  })
})

describe('isItemDirName', () => {
  it('recognises purely-digit names as item directories', () => {
    expect(isItemDirName('7')).toBe(true)
    expect(isItemDirName('123')).toBe(true)
  })
  it('rejects library-key and other non-numeric names', () => {
    expect(isItemDirName('personal')).toBe(false)
    expect(isItemDirName('ws3')).toBe(false)
    expect(isItemDirName('7a')).toBe(false)
    expect(isItemDirName('')).toBe(false)
  })
})
