import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'

function fmt(n: number): string {
  return n.toLocaleString()
}

export function TokenUsageCard({ sessionId }: { sessionId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['transcript-stats', sessionId],
    queryFn: () => api.getTranscriptStats(sessionId),
    // Mirrors the existing SessionStats query (session-modal.tsx:715):
    //   - staleTime: Infinity  — snapshot from tab-open; no refetch on
    //     re-render or refocus
    //   - gcTime: 0            — drop from cache as soon as no component
    //     observes it; closing the modal effectively unmounts, so
    //     reopening triggers a fresh fetch
    //   - refetchOnWindowFocus: false — explicit (app-wide default
    //     already false, but documented locally)
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="text-xs font-semibold uppercase text-muted-foreground">Token Usage</div>

      {isLoading && <div className="text-xs text-muted-foreground italic">Loading…</div>}

      {data && !data.ok && (
        <div className="text-xs text-muted-foreground italic">{data.message}</div>
      )}

      {data && data.ok && (
        <div className="space-y-1">
          <div className="text-xs">
            <span className="text-muted-foreground">Total calls:</span>{' '}
            <span className="font-mono">{fmt(data.data.summary.totalCalls)}</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal">Model</th>
                <th className="text-right font-normal">Calls</th>
                <th className="text-right font-normal">Input</th>
                <th className="text-right font-normal">Output</th>
                <th className="text-right font-normal">Cache read</th>
                <th className="text-right font-normal">Cache write</th>
              </tr>
            </thead>
            <tbody>
              {data.data.summary.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="font-mono">{m.model}</td>
                  <td className="text-right font-mono">{fmt(m.calls)}</td>
                  <td className="text-right font-mono">{fmt(m.inputTokens)}</td>
                  <td className="text-right font-mono">{fmt(m.outputTokens)}</td>
                  <td className="text-right font-mono">{fmt(m.cacheReadTokens)}</td>
                  <td className="text-right font-mono">
                    {fmt(m.cacheCreate5mTokens + m.cacheCreate1hTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
