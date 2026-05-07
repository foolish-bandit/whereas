import { describe, expect, it, beforeEach } from 'vitest'
import { getDevUserId, setDevUserId } from './devUser'

describe('devUser storage', () => {
  beforeEach(() => localStorage.clear())
  it('persists and reads dev user id', () => {
    setDevUserId('abc-123')
    expect(getDevUserId()).toBe('abc-123')
  })
})
