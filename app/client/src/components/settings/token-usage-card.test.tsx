import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TokenUsageCard } from './token-usage-card'

vi.mock('@/lib/api-client', () => ({
  api: { getTranscriptStats: vi.fn() },
}))

const mockApi = (await import('@/lib/api-client')) as any

function renderWithQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const SUCCESS_DATA = {
  source: 'jsonl' as const,
  summary: {
    totalCalls: 2,
    byModel: [
      {
        model: 'claude-opus-4-7',
        calls: 2,
        inputTokens: 15,
        outputTokens: 300,
        cacheReadTokens: 110,
        cacheCreate5mTokens: 0,
        cacheCreate1hTokens: 20,
      },
    ],
  },
  calls: [],
  prompts: {},
}

describe('TokenUsageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders per-model summary on success', async () => {
    mockApi.api.getTranscriptStats.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_DATA,
    })
    renderWithQuery(<TokenUsageCard sessionId="s1" />)
    expect(await screen.findByText('claude-opus-4-7')).toBeInTheDocument()
    expect(screen.getByText(/Token Usage/i)).toBeInTheDocument()
  })

  test('renders disabled-state message', async () => {
    mockApi.api.getTranscriptStats.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'disabled',
      message: 'Transcript parsing not enabled.',
    })
    renderWithQuery(<TokenUsageCard sessionId="s1" />)
    expect(await screen.findByText(/not enabled/i)).toBeInTheDocument()
  })

  test('renders file-not-found message', async () => {
    mockApi.api.getTranscriptStats.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'file_not_found',
      message: 'Transcript file not found.',
    })
    renderWithQuery(<TokenUsageCard sessionId="s1" />)
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })

  test('renders file-unreadable message distinct from not-found', async () => {
    mockApi.api.getTranscriptStats.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'file_unreadable',
      message: 'Transcript file exists but is not readable.',
    })
    renderWithQuery(<TokenUsageCard sessionId="s1" />)
    expect(await screen.findByText(/not readable/i)).toBeInTheDocument()
  })
})
