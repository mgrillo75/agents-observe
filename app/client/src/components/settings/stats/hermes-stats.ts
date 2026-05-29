// Hermes stats provider.
//
// Hermes carries token usage directly in its events (post_api_request.usage)
// and has no transcript JSONL — so we compute both the Overview stats and the
// token dataset from events alone. The token dataset is shaped as
// TranscriptStatsData so the existing TokenUsageSection renders it unchanged.

import type { ParsedEvent } from '@/types'
import type {
  TranscriptStatsData,
  TranscriptStatsByModel,
  TranscriptStatsModelPricing,
  TranscriptStatsPrompt,
} from '@/lib/api-client'
import type { SessionStatsData, ToolStat } from '@/components/settings/session-modal'
import type { AgentStatsProvider, PricingMap } from './types'

const TOOL_HOOKS = new Set(['post_tool_call', 'transform_tool_result'])

type Payload = Record<string, any>

function payloadOf(e: ParsedEvent): Payload {
  return (e.payload ?? {}) as Payload
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}

/** Per-call token breakdown extracted from a post_api_request usage blob.
 *  Hermes `input_tokens` is FRESH (excludes cache reads — input + cache_read
 *  == prompt_tokens), matching the parser's per-call convention. */
function callUsage(p: Payload) {
  const u = (p.usage ?? {}) as Payload
  const fresh = Number(u.input_tokens ?? 0)
  const output = Number(u.output_tokens ?? 0)
  const cacheRead = Number(u.cache_read_tokens ?? 0)
  const cacheWrite = Number(u.cache_write_tokens ?? 0)
  return { fresh, output, cacheRead, cacheWrite }
}

/** Cost in cents for one call, mirroring the server's per-call formula.
 *  Returns null when pricing for the model is unknown. */
function callCostCents(
  u: { fresh: number; output: number; cacheRead: number; cacheWrite: number },
  pricing: TranscriptStatsModelPricing | null | undefined,
): number | null {
  if (!pricing) return null
  const dollars =
    (u.fresh * pricing.inputPerM +
      u.output * pricing.outputPerM +
      u.cacheRead * pricing.cacheReadPerM +
      u.cacheWrite * pricing.cacheCreate5mPerM) /
    1_000_000
  return dollars * 100
}

/** Overview + Tool Usage stats for the SessionStats top sections. */
export function computeHermesOverview(events: ParsedEvent[], _sessionId: string): SessionStatsData {
  let userPrompts = 0
  let toolCalls = 0
  let apiRequests = 0
  let apiSuccess = 0
  const toolCounts = new Map<string, number>()
  const toolDurations = new Map<string, number[]>()
  let longestToolCall: { tool: string; durationMs: number; eventId: number } | null = null
  const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

  const firstTs = events.length > 0 ? events[0].timestamp : 0
  const lastTs = events.length > 0 ? events[events.length - 1].timestamp : 0

  for (const e of events) {
    const p = payloadOf(e)
    if (e.hookName === 'pre_llm_call') userPrompts++
    if (TOOL_HOOKS.has(e.hookName)) {
      toolCalls++
      const tool = typeof p.tool_name === 'string' ? p.tool_name : 'tool'
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1)
      if (typeof p.duration_ms === 'number') {
        const arr = toolDurations.get(tool) ?? []
        arr.push(p.duration_ms)
        toolDurations.set(tool, arr)
        if (!longestToolCall || p.duration_ms > longestToolCall.durationMs) {
          longestToolCall = { tool, durationMs: p.duration_ms, eventId: e.id }
        }
      }
    }
    if (e.hookName === 'post_api_request') {
      apiRequests++
      if (p.finish_reason === 'stop') apiSuccess++
      const u = callUsage(p)
      totalTokens.input += u.fresh + u.cacheRead + u.cacheWrite
      totalTokens.output += u.output
      totalTokens.cacheRead += u.cacheRead
      totalTokens.cacheCreation += u.cacheWrite
    }
  }

  const tools: ToolStat[] = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const durs = (toolDurations.get(name) ?? []).slice().sort((a, b) => a - b)
      return {
        name,
        count,
        minMs: durs.length > 0 ? durs[0] : null,
        medianMs: durs.length > 0 ? median(durs) : null,
        maxMs: durs.length > 0 ? durs[durs.length - 1] : null,
      }
    })

  const durationMs = lastTs - firstTs
  const successRate = apiRequests > 0 ? `${Math.round((apiSuccess / apiRequests) * 100)}%` : '—'

  return {
    duration: fmtDuration(durationMs),
    totalEvents: events.length,
    toolCalls,
    subagentsSpawned: 0,
    userPrompts,
    gitCommits: 0,
    permissionRequests: 0,
    permissionDenials: 0,
    toolSuccessRate: successRate,
    tools,
    longestToolCall,
    filesTouched: 0,
    filesRead: 0,
    filesEdited: 0,
    turns: userPrompts,
    userPromptsFromEvents: userPrompts,
    agentUsage: [],
    totalTokens,
    sessionDurationMs: durationMs,
    mainAgentToolCount: toolCalls,
  }
}

/** Build the TranscriptStatsData-shaped token dataset from events + pricing. */
export function computeHermesTokenStats(
  events: ParsedEvent[],
  _sessionId: string,
  pricing: PricingMap,
): TranscriptStatsData {
  const byModelMap = new Map<string, TranscriptStatsByModel>()
  const prompts: TranscriptStatsPrompt[] = []

  // Turn grouping: each pre_llm_call opens a turn; api calls/tools until the
  // next pre_llm_call belong to it.
  let turn: {
    promptId: string
    text: string
    timestamp: number
    durationMs: number
    toolCount: number
    requests: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreate5mTokens: number
    cacheCreate1hTokens: number
    models: Set<string>
    costCents: number | null
  } | null = null

  const flushTurn = () => {
    if (!turn) return
    prompts.push({
      promptId: turn.promptId,
      text: turn.text,
      command: null,
      timestamp: turn.timestamp,
      durationMs: turn.durationMs || null,
      toolCount: turn.toolCount,
      requests: turn.requests,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheCreate5mTokens: turn.cacheCreate5mTokens,
      cacheCreate1hTokens: turn.cacheCreate1hTokens,
      models: [...turn.models],
      costCents: turn.costCents,
    })
    turn = null
  }

  let inputTotal = 0
  let outputTotal = 0
  let cacheReadTotal = 0
  let costTotalCents: number | null = 0
  let totalCalls = 0
  const firstTs = events.length > 0 ? events[0].timestamp : null
  const lastTs = events.length > 0 ? events[events.length - 1].timestamp : null

  for (const e of events) {
    const p = payloadOf(e)
    if (e.hookName === 'pre_llm_call') {
      flushTurn()
      turn = {
        promptId: String(e.id),
        text: typeof p.user_message === 'string' ? p.user_message : '',
        timestamp: e.timestamp,
        durationMs: 0,
        toolCount: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreate5mTokens: 0,
        cacheCreate1hTokens: 0,
        models: new Set<string>(),
        costCents: 0,
      }
      continue
    }
    if (TOOL_HOOKS.has(e.hookName) && turn) turn.toolCount++
    if (e.hookName === 'post_api_request') {
      const model = typeof p.model === 'string' ? p.model : 'unknown'
      const u = callUsage(p)
      const bundledInput = u.fresh + u.cacheRead + u.cacheWrite
      const cost = callCostCents(u, pricing[model])

      // By-model aggregation.
      const row = byModelMap.get(model) ?? {
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreate5mTokens: 0,
        cacheCreate1hTokens: 0,
        costCents: 0 as number | null,
      }
      row.calls++
      row.inputTokens += bundledInput
      row.outputTokens += u.output
      row.cacheReadTokens += u.cacheRead
      row.cacheCreate5mTokens += u.cacheWrite
      row.costCents = row.costCents == null || cost == null ? null : row.costCents + cost
      byModelMap.set(model, row)

      // Session totals.
      totalCalls++
      inputTotal += bundledInput
      outputTotal += u.output
      cacheReadTotal += u.cacheRead
      costTotalCents = costTotalCents == null || cost == null ? null : costTotalCents + cost

      // Turn rollup.
      if (turn) {
        turn.requests++
        turn.inputTokens += bundledInput
        turn.outputTokens += u.output
        turn.cacheReadTokens += u.cacheRead
        turn.cacheCreate5mTokens += u.cacheWrite
        turn.models.add(model)
        if (typeof p.api_duration === 'number') turn.durationMs += p.api_duration * 1000
        turn.costCents = turn.costCents == null || cost == null ? null : turn.costCents + cost
      }
    }
  }
  flushTurn()

  const models: Record<string, { pricing: TranscriptStatsModelPricing | null }> = {}
  for (const model of byModelMap.keys()) models[model] = { pricing: pricing[model] ?? null }

  return {
    source: 'jsonl',
    summary: {
      totalCalls,
      inputTotal,
      outputTotal,
      cacheHitRate: inputTotal > 0 ? cacheReadTotal / inputTotal : 0,
      costTotalCents,
      startedAt: firstTs,
      durationMs: firstTs != null && lastTs != null ? lastTs - firstTs : null,
      toolCalls: prompts.reduce((s, p) => s + p.toolCount, 0),
      filesRead: 0,
      filesEdited: 0,
      gitCommits: 0,
      toolStats: [],
      userPrompts: prompts.length,
    },
    byModel: [...byModelMap.values()],
    prompts,
    subagents: [],
    models,
    errors: [],
  }
}

/** Distinct model ids referenced by this session's API-request events. Used to
 *  fetch just the pricing we need from /api/models/pricing. */
export function hermesModelIds(events: ParsedEvent[]): string[] {
  const out = new Set<string>()
  for (const e of events) {
    if (e.hookName !== 'post_api_request') continue
    const m = (e.payload as Payload)?.model
    if (typeof m === 'string' && m) out.add(m)
  }
  return [...out]
}

export const hermesStatsProvider: AgentStatsProvider = {
  agentClass: 'hermes',
  usesTranscript: false,
  computeOverview: computeHermesOverview,
  modelIds: hermesModelIds,
  computeTokenStats: computeHermesTokenStats,
}
