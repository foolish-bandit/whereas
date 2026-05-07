import { describe, expect, it, vi } from 'vitest'
import { getContracts, ApiError } from './api'

describe('api', () => {
  it('injects dev header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
    await getContracts('dev-id')
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).get('X-Whereas-Dev-User')).toBe('dev-id')
  })

  it('maps non-2xx to ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ detail: 'Missing' }) }))
    await expect(getContracts('dev-id')).rejects.toBeInstanceOf(ApiError)
  })
})
