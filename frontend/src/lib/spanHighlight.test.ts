import { describe, expect, it } from 'vitest'
import { getHighlightSegments } from './spanHighlight'

describe('getHighlightSegments', () => {
  it('returns null for invalid bounds', () => {
    expect(getHighlightSegments('abc', -1, 2)).toBeNull()
    expect(getHighlightSegments('abc', 2, 1)).toBeNull()
    expect(getHighlightSegments('abc', 1, 5)).toBeNull()
  })
})
