import { describe, test, expect, beforeEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionTranscripts } from './index'
import { _testReset } from './models-pricing'
import type { EventStore } from '../storage/types'

beforeEach(() => {
  _testReset()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        anthropic: {
          models: {
            'claude-opus-4-7': {
              id: 'claude-opus-4-7',
              cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
            },
          },
        },
      }),
    }),
  )
})

const MAIN_FIXTURE_LINES = [
  {
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    promptId: 'p1',
    timestamp: '2026-05-22T00:00:00.000Z',
    message: { content: 'hi' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'u1',
    timestamp: '2026-05-22T00:00:01.000Z',
    isSidechain: false,
    message: {
      id: 'msg1',
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      },
      content: [{ type: 'text', text: 'hi' }],
    },
  },
]

function writeMainFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-stats-v2-'))
  const p = join(dir, 'session.jsonl')
  writeFileSync(p, MAIN_FIXTURE_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return p
}

function makeStore(opts: { agents: Array<{ id: string; agent_class: string }> }): EventStore {
  return {
    getSessionTranscriptPath: async () => null,
    getAgentsForSession: async () => opts.agents as any,
  } as unknown as EventStore
}

describe('parseSessionTranscripts', () => {
  test('aggregates main-only when there are no subagents and attaches pricing', async () => {
    const path = writeMainFixture()
    const store = makeStore({ agents: [{ id: 'sess1', agent_class: 'claude-code' }] })
    const stats = await parseSessionTranscripts('sess1', store, path)
    expect(stats.source).toBe('jsonl')
    expect(stats.summary.totalCalls).toBe(1)
    expect(stats.byModel).toHaveLength(1)
    expect(stats.byModel[0].model).toBe('claude-opus-4-7')
    // 1000 input * $15/M + 500 output * $75/M = $0.015 + $0.0375 = $0.0525 → 5 cents
    expect(stats.byModel[0].costCents).toBe(5)
    expect(stats.summary.costTotalCents).toBe(5)
    expect(stats.models['claude-opus-4-7'].pricing).toMatchObject({ inputPerM: 15 })
  })

  test('costCents is null when pricing is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ anthropic: { models: {} } }),
      }),
    )
    _testReset()
    const path = writeMainFixture()
    const store = makeStore({ agents: [{ id: 'sess1', agent_class: 'claude-code' }] })
    const stats = await parseSessionTranscripts('sess1', store, path)
    expect(stats.byModel[0].costCents).toBeNull()
    expect(stats.summary.costTotalCents).toBeNull()
    expect(stats.models['claude-opus-4-7'].pricing).toBeNull()
  })

  test('unsupported agent class records an error without failing', async () => {
    const path = writeMainFixture()
    const store = makeStore({
      agents: [
        { id: 'sess1', agent_class: 'claude-code' },
        { id: 'codex-agent', agent_class: 'codex' },
      ],
    })
    const stats = await parseSessionTranscripts('sess1', store, path)
    expect(stats.errors).toContainEqual(
      expect.objectContaining({
        scope: 'main',
        code: 'parse_error',
        message: expect.stringContaining('codex'),
      }),
    )
    expect(stats.byModel).toHaveLength(1)
  })
})
