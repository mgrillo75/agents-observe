import { describe, test, expect, beforeEach, vi } from 'vitest'

const MODELS_DEV_FIXTURE = {
  anthropic: {
    models: {
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
      },
      'gpt-4o': {
        id: 'gpt-4o',
        cost: { input: 5, output: 15 },
      },
    },
  },
}

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('./models-pricing')
  mod._testReset()
})

describe('getModelsPricing', () => {
  test('fetches and returns claude- models only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => MODELS_DEV_FIXTURE }),
    )
    const { getModelsPricing } = await import('./models-pricing')
    const map = await getModelsPricing()
    expect(map['claude-opus-4-7']).toBeDefined()
    expect(map['claude-haiku-4-5']).toBeDefined()
    expect(map['gpt-4o']).toBeUndefined()
  })

  test('parses per-million-token rates correctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => MODELS_DEV_FIXTURE }),
    )
    const { getModelsPricing } = await import('./models-pricing')
    const map = await getModelsPricing()
    expect(map['claude-opus-4-7']).toEqual({
      inputPerM: 15,
      outputPerM: 75,
      cacheReadPerM: 1.5,
      cacheCreate5mPerM: 18.75,
      cacheCreate1hPerM: 18.75,
    })
  })

  test('returns cached map on second call without re-fetching', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => MODELS_DEV_FIXTURE })
    vi.stubGlobal('fetch', fetchSpy)
    const { getModelsPricing } = await import('./models-pricing')
    await getModelsPricing()
    await getModelsPricing()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('fetch failure with empty cache returns empty map (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { getModelsPricing } = await import('./models-pricing')
    const map = await getModelsPricing()
    expect(map).toEqual({})
  })

  test('fetch failure with stale cache returns stale data', async () => {
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount += 1
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: async () => MODELS_DEV_FIXTURE })
        }
        return Promise.reject(new Error('network down'))
      }),
    )
    const mod = await import('./models-pricing')
    await mod.getModelsPricing()
    mod._testForceExpiry()
    const map = await mod.getModelsPricing()
    expect(map['claude-opus-4-7']).toBeDefined()
  })
})
