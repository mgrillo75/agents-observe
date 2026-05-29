import { describe, it, expect } from 'vitest'
import type { ParsedEvent } from '@/types'
import { computeHermesOverview, computeHermesTokenStats, hermesModelIds } from './hermes-stats'

let nextId = 1
function ev(hookName: string, payload: Record<string, unknown>, timestamp: number): ParsedEvent {
  return { id: nextId++, agentId: 'sess', hookName, timestamp, payload } as unknown as ParsedEvent
}

// One turn: prompt → API request (with usage) → reply → output → tool call → end.
function sampleEvents(): ParsedEvent[] {
  nextId = 1
  return [
    ev('on_session_start', { model: 'chatgpt/gpt-5.5', platform: 'cli' }, 1000),
    ev('pre_llm_call', { user_message: 'hello again' }, 1100),
    ev(
      'post_api_request',
      {
        model: 'chatgpt/gpt-5.5',
        finish_reason: 'stop',
        api_duration: 2.5,
        usage: {
          input_tokens: 11389,
          output_tokens: 21,
          cache_read_tokens: 10752,
          cache_write_tokens: 0,
          total_tokens: 22162,
        },
      },
      1200,
    ),
    ev('post_llm_call', { assistant_response: 'Hey Joe' }, 1300),
    ev('transform_llm_output', { response_text: 'Hey Joe' }, 1350),
    ev('post_tool_call', { tool_name: 'skill_view', args: { name: 'x' }, duration_ms: 57 }, 1400),
    ev('on_session_end', { completed: true, interrupted: false }, 1500),
  ]
}

const PRICING = {
  'chatgpt/gpt-5.5': {
    inputPerM: 1.25,
    outputPerM: 10,
    cacheReadPerM: 0.125,
    cacheCreate5mPerM: 0,
    cacheCreate1hPerM: 0,
  },
}

describe('computeHermesOverview', () => {
  const s = computeHermesOverview(sampleEvents(), 'sess')
  it('counts prompts, turns, tool calls', () => {
    expect(s.userPrompts).toBe(1)
    expect(s.turns).toBe(1)
    expect(s.toolCalls).toBe(1)
    expect(s.mainAgentToolCount).toBe(1)
  })
  it('derives API success rate and tool stats', () => {
    expect(s.toolSuccessRate).toBe('100%')
    expect(s.tools).toEqual([
      expect.objectContaining({ name: 'skill_view', count: 1, minMs: 57, maxMs: 57 }),
    ])
    expect(s.longestToolCall).toEqual({ tool: 'skill_view', durationMs: 57, eventId: 6 })
  })
  it('sums token totals from post_api_request usage', () => {
    expect(s.totalTokens).toEqual({ input: 22141, output: 21, cacheRead: 10752, cacheCreation: 0 })
  })
})

describe('computeHermesTokenStats', () => {
  const t = computeHermesTokenStats(sampleEvents(), 'sess', PRICING)

  it('aggregates by model with bundled input + cost', () => {
    expect(t.byModel).toHaveLength(1)
    const row = t.byModel[0]
    expect(row.model).toBe('chatgpt/gpt-5.5')
    expect(row.calls).toBe(1)
    expect(row.inputTokens).toBe(22141) // fresh + cacheRead + cacheWrite
    expect(row.outputTokens).toBe(21)
    expect(row.cacheReadTokens).toBe(10752)
    // (11389*1.25 + 21*10 + 10752*0.125) / 1e6 * 100
    expect(row.costCents).toBeCloseTo(1.579025, 4)
  })

  it('builds a per-turn prompt row', () => {
    expect(t.prompts).toHaveLength(1)
    const p = t.prompts[0]
    expect(p.text).toBe('hello again')
    expect(p.requests).toBe(1)
    expect(p.toolCount).toBe(1)
    expect(p.models).toEqual(['chatgpt/gpt-5.5'])
    expect(p.durationMs).toBe(2500) // api_duration 2.5s → ms
  })

  it('summary reflects totals + cache hit rate', () => {
    expect(t.summary.totalCalls).toBe(1)
    expect(t.summary.inputTotal).toBe(22141)
    expect(t.summary.outputTotal).toBe(21)
    expect(t.summary.cacheHitRate).toBeCloseTo(10752 / 22141, 4)
    expect(t.summary.costTotalCents).toBeCloseTo(1.579025, 4)
  })

  it('costCents is null when pricing is unknown', () => {
    const t2 = computeHermesTokenStats(sampleEvents(), 'sess', {})
    expect(t2.byModel[0].costCents).toBeNull()
    expect(t2.summary.costTotalCents).toBeNull()
  })
})

describe('hermesModelIds', () => {
  it('returns distinct models from post_api_request events', () => {
    expect(hermesModelIds(sampleEvents())).toEqual(['chatgpt/gpt-5.5'])
  })
})
