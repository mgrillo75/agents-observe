import type { AgentStatsProvider } from './types'
import { hermesStatsProvider } from './hermes-stats'

// Registry of per-agent-class stats providers. Claude Code is NOT registered —
// it's the built-in default path in SessionStats (events sub-agents + transcript
// JSONL). Classes that compute stats from events alone register here.
const providers: Record<string, AgentStatsProvider> = {
  [hermesStatsProvider.agentClass]: hermesStatsProvider,
}

export function getStatsProvider(agentClass: string | null | undefined): AgentStatsProvider | null {
  return (agentClass && providers[agentClass]) || null
}

export type { AgentStatsProvider, PricingMap } from './types'
