import type { ParsedEvent } from '@/types'
import type { TranscriptStatsData, TranscriptStatsModelPricing } from '@/lib/api-client'
import type { SessionStatsData } from '@/components/settings/session-modal'

/** model id → pricing (or null when unknown). Keyed by the id as it appears
 *  in events; the server endpoint handles normalization. */
export type PricingMap = Record<string, TranscriptStatsModelPricing | null>

/**
 * Per-agent-class stats computation. Lets each agent class derive the Stats
 * modal's data from its own event shape. Claude Code is the built-in default
 * (events for sub-agents + transcript JSONL augmentation); classes that carry
 * usage in events (Hermes) register a provider that computes everything from
 * events — no transcript fetch.
 */
export interface AgentStatsProvider {
  agentClass: string
  /** Overview + Tool Usage stats for the top of the modal. */
  computeOverview(events: ParsedEvent[], sessionId: string): SessionStatsData
  /** When false, the session has no transcript JSONL: SessionStats skips the
   *  transcript fetch and feeds computeTokenStats() to the renderer instead. */
  usesTranscript: boolean
  /** Distinct model ids whose pricing the provider needs (events-native
   *  classes only) so SessionStats can fetch just those. */
  modelIds?(events: ParsedEvent[]): string[]
  /** Build the normalized token dataset (TranscriptStatsData shape) from
   *  events + pricing. Required when usesTranscript is false. */
  computeTokenStats?(
    events: ParsedEvent[],
    sessionId: string,
    pricing: PricingMap,
  ): TranscriptStatsData
}
