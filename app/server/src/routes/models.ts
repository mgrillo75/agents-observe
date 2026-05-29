// app/server/src/routes/models.ts
//
// Model pricing lookup endpoint. Surfaces the same models.dev pricing map the
// transcript parser uses (getModelsPricing — 24h mem+disk cache, never throws)
// so agent classes WITHOUT a transcript (e.g. Hermes, which carries token usage
// directly in its events) can compute cost client-side.

import { Hono } from 'hono'
import { getModelsPricing } from '../transcript-parser/models-pricing'
import type { ModelPricing } from '../transcript-parser/types'

const router = new Hono()

/**
 * Normalize a model id for pricing lookup. models.dev keys are bare, undated
 * ids (e.g. `gpt-5.5`); agent runtimes often prefix a provider/router segment
 * and/or append a release date:
 *   "chatgpt/gpt-5.5"            → "gpt-5.5"
 *   "anthropic/claude-x-20260514" → "claude-x"
 * Lookups try the raw id first (preserves exact matches the parser relies on),
 * then this normalized form.
 */
export function normalizeModelId(id: string): string {
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return bare.replace(/-\d{8}$/, '')
}

router.get('/models/pricing', async (c) => {
  const pricing = await getModelsPricing()
  const lookup = (id: string): ModelPricing | null =>
    pricing[id] ?? pricing[normalizeModelId(id)] ?? null

  const idsParam = c.req.query('ids')
  if (!idsParam) {
    // No filter → return the full map. Callers normally pass ?ids= to keep
    // the payload to just the models they need.
    return c.json({ pricing })
  }

  const out: Record<string, ModelPricing | null> = {}
  for (const id of idsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    out[id] = lookup(id)
  }
  return c.json({ pricing: out })
})

export default router
