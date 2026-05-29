import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeModelId } from './models'

describe('normalizeModelId', () => {
  test('strips a provider/router prefix', () => {
    expect(normalizeModelId('chatgpt/gpt-5.5')).toBe('gpt-5.5')
    expect(normalizeModelId('openrouter/anthropic/claude-x')).toBe('claude-x')
  })
  test('strips a trailing -YYYYMMDD date stamp', () => {
    expect(normalizeModelId('claude-sonnet-4-20260514')).toBe('claude-sonnet-4')
  })
  test('strips both prefix and date', () => {
    expect(normalizeModelId('anthropic/claude-opus-4-20260101')).toBe('claude-opus-4')
  })
  test('leaves bare ids untouched', () => {
    expect(normalizeModelId('gpt-5.5')).toBe('gpt-5.5')
  })
})

describe('GET /models/pricing', () => {
  let tmpDir = ''

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'models-route-'))
    process.env.AGENTS_OBSERVE_DB_PATH = join(tmpDir, 'observe.db')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          openai: {
            models: {
              'gpt-5.4': { id: 'gpt-5.4', cost: { input: 5, output: 15, cache_read: 0.5 } },
            },
          },
        }),
      }),
    )
  })

  afterEach(() => {
    delete process.env.AGENTS_OBSERVE_DB_PATH
    vi.unstubAllGlobals()
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  test('returns pricing for requested ids, normalizing the provider prefix', async () => {
    const { default: router } = await import('./models')
    const res = await router.request('/models/pricing?ids=chatgpt/gpt-5.4,unknown-model')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pricing: Record<string, unknown> }
    expect(body.pricing['chatgpt/gpt-5.4']).toMatchObject({
      inputPerM: 5,
      outputPerM: 15,
      cacheReadPerM: 0.5,
    })
    // Unknown models resolve to null rather than being omitted.
    expect(body.pricing['unknown-model']).toBeNull()
  })
})
