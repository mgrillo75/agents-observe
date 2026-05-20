# All Filter Exclusions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PostToolBatch` (and any user-configured event types) hide from the timeline and event stream by default, while remaining in the database and the raw-events logs modal.

**Architecture:** Add a new default filter row (`id: 'default-all'`) whose negated patterns express which events to hide. Inside the client `processEvent` functions, after computing the normal pill filters, call a new `passesAllFilter(...)` helper. When it returns false, force `displayEventStream` and `displayTimeline` to `false` on the enriched event. `applyFilters` is modified to skip the `default-all` row so it never produces a pill of its own. The Settings UI re-uses the existing `FilterEditor` with small presets (sort first, hide display/combinator/color, default new patterns to `negate: true`).

**Tech Stack:** React + Zustand on the client, Hono + better-sqlite3 on the server. Vitest for both. Existing filter machinery: `compileFilters` (re2js) → `applyFilters` matcher → per-event `displayEventStream`/`displayTimeline` flags consumed by event stream and timeline.

**Spec:** `docs/superpowers/specs/2026-05-20-all-filter-exclusions-design.md`

---

## File Structure

**Create:**
- `app/client/src/lib/filters/all-filter.ts` — `passesAllFilter(raw, toolName, compiledFilters)` helper. ~30 lines.
- `app/client/src/lib/filters/all-filter.test.ts` — unit tests for the helper.

**Modify:**
- `app/server/src/storage/seed-filters.ts` — add `default-all` seed entry at top of `SEED_FILTERS`.
- `app/server/src/storage/sqlite-adapter.test.ts` — add assertion that `default-all` is seeded.
- `app/client/src/lib/filters/matcher.ts` — skip `default-all` in `applyFilters` so it never produces a pill.
- `app/client/src/lib/filters/matcher.test.ts` — add a test for the skip behavior.
- `app/client/src/agents/claude-code/process-event.ts` — call `passesAllFilter`; force display flags to `false` on fail.
- `app/client/src/agents/claude-code/process-event.test.ts` — add tests for the new gating.
- `app/client/src/agents/default/index.tsx` — same gating (codex inherits via `default`).
- `app/client/src/components/settings/filters-tab.tsx` — sort `default-all` first; render contextual caption; hide display/combinator/color when editing it; default new pattern rows to `negate: true`.
- `app/client/src/components/settings/filters-tab.test.tsx` — UI tests for the above.

---

## Task 1: Seed the `default-all` filter row

**Files:**
- Modify: `app/server/src/storage/seed-filters.ts`
- Test: `app/server/src/storage/sqlite-adapter.test.ts`

- [ ] **Step 1.1: Add a failing test that `default-all` is seeded**

Open `app/server/src/storage/sqlite-adapter.test.ts`, find the existing `seedDefaultFilters` test (search for `seedDefaultFilters inserts all seeds`), and add this new `test(...)` block right after it (same `describe` block — the test should use the same patterns as its siblings):

```ts
test('seedDefaultFilters inserts the default-all exclusion row', async () => {
  const adapter = new SqliteAdapter(':memory:')
  await adapter.seedDefaultFilters()
  const all = await adapter.getFilterById('default-all')
  expect(all).not.toBeNull()
  expect(all?.name).toBe('All')
  expect(all?.pillName).toBe('All')
  expect(all?.kind).toBe('default')
  expect(all?.enabled).toBe(true)
  expect(all?.combinator).toBe('and')
  expect(all?.patterns).toEqual([
    { target: 'hook', regex: '^PostToolBatch$', negate: true },
  ])
  expect(all?.config).toEqual({ role: 'all-exclusions' })
})
```

- [ ] **Step 1.2: Run the test and confirm it fails**

```bash
just test-server -- sqlite-adapter
```

Expected: the new test fails with `expect(all).toBeDefined()` because the seed doesn't include `default-all` yet.

- [ ] **Step 1.3: Add the seed entry**

In `app/server/src/storage/seed-filters.ts`, insert a new entry at the top of `SEED_FILTERS` (before `default-dynamic-tool-name`):

```ts
{
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  config: { role: 'all-exclusions' },
},
```

- [ ] **Step 1.4: Run the test and confirm it passes**

```bash
just test-server -- sqlite-adapter
```

Expected: pass.

- [ ] **Step 1.5: Commit**

```bash
git add app/server/src/storage/seed-filters.ts app/server/src/storage/sqlite-adapter.test.ts
git commit -m "feat: seed default-all exclusion filter (hides PostToolBatch)"
```

---

## Task 2: `passesAllFilter` client helper

**Files:**
- Create: `app/client/src/lib/filters/all-filter.ts`
- Test: `app/client/src/lib/filters/all-filter.test.ts`

- [ ] **Step 2.1: Write the failing test file**

Create `app/client/src/lib/filters/all-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { passesAllFilter } from './all-filter'
import { compileFilters } from './compile'
import type { Filter } from '@/types'

const ALL_FILTER: Filter = {
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  kind: 'default',
  enabled: true,
  config: { role: 'all-exclusions' },
  createdAt: 0,
  updatedAt: 0,
}

const POST_TOOL_BATCH_RAW = {
  id: 1,
  agentId: 'a',
  hookName: 'PostToolBatch',
  timestamp: 0,
  payload: {},
}

const PRE_TOOL_USE_RAW = {
  id: 2,
  agentId: 'a',
  hookName: 'PreToolUse',
  timestamp: 0,
  payload: { tool_name: 'Bash' },
}

describe('passesAllFilter', () => {
  it('returns true when default-all is not present (deleted)', () => {
    const compiled = compileFilters([])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(true)
  })

  it('returns true when default-all is disabled', () => {
    const compiled = compileFilters([{ ...ALL_FILTER, enabled: false }])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(true)
  })

  it('returns false for an event whose hook matches a negated pattern', () => {
    const compiled = compileFilters([ALL_FILTER])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(false)
  })

  it('returns true for an event whose hook does not match any pattern', () => {
    const compiled = compileFilters([ALL_FILTER])
    expect(passesAllFilter(PRE_TOOL_USE_RAW, 'Bash', compiled)).toBe(true)
  })

  it('combines multiple patterns with AND (all exclusions must hold)', () => {
    const compiled = compileFilters([
      {
        ...ALL_FILTER,
        patterns: [
          { target: 'hook', regex: '^PostToolBatch$', negate: true },
          { target: 'hook', regex: '^Notification$', negate: true },
        ],
      },
    ])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(false)
    expect(
      passesAllFilter(
        { ...PRE_TOOL_USE_RAW, hookName: 'Notification' },
        null,
        compiled,
      ),
    ).toBe(false)
    expect(passesAllFilter(PRE_TOOL_USE_RAW, 'Bash', compiled)).toBe(true)
  })
})
```

- [ ] **Step 2.2: Run the test, confirm it fails**

```bash
just test-client -- all-filter
```

Expected: fail with "Cannot find module './all-filter'".

- [ ] **Step 2.3: Create the helper**

Create `app/client/src/lib/filters/all-filter.ts`:

```ts
import type { RawEvent } from '@/agents/types'
import type { CompiledFilter } from './types'

/** Stable id of the All filter row; matched by `seed-filters.ts`. */
export const ALL_FILTER_ID = 'default-all'

/**
 * Returns true if the event should be visible in the timeline and event
 * stream — i.e., it passes the All filter's negated exclusion patterns.
 *
 * If the All filter is absent from the compiled set (deleted by the user,
 * or disabled — `compileFilters` skips disabled rows), every event passes.
 */
export function passesAllFilter(
  raw: RawEvent,
  toolName: string | null,
  compiled: readonly CompiledFilter[],
): boolean {
  const all = compiled.find((f) => f.id === ALL_FILTER_ID)
  if (!all) return true

  let payloadText: string | null = null
  const getPayload = () => payloadText ?? (payloadText = JSON.stringify(raw))

  const wantAll = all.combinator === 'and'
  let matched = wantAll
  for (const p of all.patterns) {
    const target =
      p.target === 'hook'
        ? (raw.hookName ?? '')
        : p.target === 'tool'
          ? (toolName ?? '')
          : getPayload()
    const hit = p.negate ? !p.regex.test(target) : p.regex.test(target)
    if (wantAll && !hit) {
      matched = false
      break
    }
    if (!wantAll && hit) {
      matched = true
      break
    }
  }
  return matched
}
```

- [ ] **Step 2.4: Run the test, confirm it passes**

```bash
just test-client -- all-filter
```

Expected: all 5 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add app/client/src/lib/filters/all-filter.ts app/client/src/lib/filters/all-filter.test.ts
git commit -m "feat: add passesAllFilter helper for event-visibility gating"
```

---

## Task 3: Skip `default-all` in `applyFilters`

The All filter must never produce a pill in the filter bar. Even though its `pillName` is "All", the existing static "All" button is a separate UI element and the new filter row's pill should be suppressed.

**Files:**
- Modify: `app/client/src/lib/filters/matcher.ts`
- Test: `app/client/src/lib/filters/matcher.test.ts`

- [ ] **Step 3.1: Add failing test**

The existing `matcher.test.ts` defines a local `compile({...})` helper (around the top of the file) that builds a `CompiledFilter` directly and uses `name` as the id. Re-use it. Add this test at the end of the `describe('applyFilters', ...)` block:

```ts
test('skips the default-all filter so it never produces a pill', () => {
  const f = compile({
    name: 'default-all', // local helper sets id := name
    pillName: 'All',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  })
  const raw = {
    id: 1,
    agentId: 'a',
    hookName: 'PreToolUse',
    timestamp: 0,
    payload: {},
  }
  expect(applyFilters(raw, 'Bash', [f])).toEqual({ primary: [], secondary: [] })
})
```

- [ ] **Step 3.2: Run test, confirm it fails**

```bash
just test-client -- matcher
```

Expected: fail — the test reports `primary: ['All']` because `applyFilters` currently includes every matching filter.

- [ ] **Step 3.3: Implement the skip**

In `app/client/src/lib/filters/matcher.ts`, modify the matching loop to skip the All filter row. Update the top of the file:

```ts
import { ALL_FILTER_ID } from './all-filter'
```

Then inside `applyFilters`, at the start of the `for (const f of compiled)` loop body, add:

```ts
  for (const f of compiled) {
    if (f.id === ALL_FILTER_ID) continue
    const wantAll = f.combinator === 'and'
```

(Just the new `if` line — keep the rest of the loop body unchanged.)

- [ ] **Step 3.4: Run test, confirm it passes**

```bash
just test-client -- matcher
```

Expected: all matcher tests pass, including the new one.

- [ ] **Step 3.5: Commit**

```bash
git add app/client/src/lib/filters/matcher.ts app/client/src/lib/filters/matcher.test.ts
git commit -m "feat: skip default-all in applyFilters so it never produces a pill"
```

---

## Task 4: Wire `passesAllFilter` into `processEvent` (Claude Code)

**Files:**
- Modify: `app/client/src/agents/claude-code/process-event.ts`
- Test: `app/client/src/agents/claude-code/process-event.test.ts` (extend if it exists, otherwise create)

- [ ] **Step 4.1: Check whether the test file exists**

```bash
ls app/client/src/agents/claude-code/process-event.test.ts 2>/dev/null || echo "MISSING"
```

If MISSING, create a minimal one. Otherwise extend.

- [ ] **Step 4.2: Add the failing test**

Append (or include in a new file) this test. The `createCtx` helper below stubs the parts of `ProcessingContext` that `processEvent` actually reads.

```ts
import { describe, it, expect } from 'vitest'
import { processEvent } from './process-event'
import { compileFilters } from '@/lib/filters/compile'
import type { Filter } from '@/types'
import type { ProcessingContext } from '../types'

const ALL_FILTER: Filter = {
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  kind: 'default',
  enabled: true,
  config: { role: 'all-exclusions' },
  createdAt: 0,
  updatedAt: 0,
}

function createCtx(filters: Filter[] = [ALL_FILTER]): ProcessingContext {
  return {
    dedupEnabled: true,
    compiledFilters: compileFilters(filters),
    getAgent: () => undefined,
    getGroupedEvents: () => [],
    getAgentEvents: () => [],
    getCurrentTurn: () => null,
    setCurrentTurn: () => {},
    clearCurrentTurn: () => {},
    getPendingGroup: () => null,
    setPendingGroup: () => {},
    clearPendingGroup: () => {},
    stashPendingAgentMeta: () => {},
    consumePendingAgentMeta: () => null,
    updateEvent: () => {},
  }
}

describe('claude-code processEvent — All filter gating', () => {
  it('hides PostToolBatch events from timeline and event stream when default-all is enabled', () => {
    const raw = { id: 1, agentId: 'a', hookName: 'PostToolBatch', timestamp: 0, payload: {} }
    const { event } = processEvent(raw, createCtx())
    expect(event.displayEventStream).toBe(false)
    expect(event.displayTimeline).toBe(false)
  })

  it('shows PostToolBatch events when default-all is disabled', () => {
    const raw = { id: 1, agentId: 'a', hookName: 'PostToolBatch', timestamp: 0, payload: {} }
    const { event } = processEvent(raw, createCtx([{ ...ALL_FILTER, enabled: false }]))
    // PostToolBatch's own display flags are otherwise true at the point
    // we're testing (no Pre/Post pairing happens for a standalone batch).
    expect(event.displayEventStream).toBe(true)
    expect(event.displayTimeline).toBe(true)
  })

  it('shows non-excluded events with default-all enabled', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'UserPromptSubmit',
      timestamp: 0,
      payload: { prompt: 'hi' },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.displayEventStream).toBe(true)
    expect(event.displayTimeline).toBe(true)
  })
})
```

- [ ] **Step 4.3: Run test, confirm it fails**

```bash
just test-client -- process-event
```

Expected: the "hides PostToolBatch" assertion fails — both flags are currently `true` for a standalone PostToolBatch event.

- [ ] **Step 4.4: Modify `process-event.ts`**

Open `app/client/src/agents/claude-code/process-event.ts`. Add the import near the top:

```ts
import { passesAllFilter } from '@/lib/filters/all-filter'
```

Then near the bottom of the function, where the enriched event is built (look for the `displayEventStream,` / `displayTimeline,` fields in the returned object — around line 364), compute the gate once before the return and AND it into the flags. Replace:

```ts
    displayEventStream,
    displayTimeline,
```

with:

```ts
    displayEventStream: passesAllFilter(raw, toolName, ctx.compiledFilters) && displayEventStream,
    displayTimeline: passesAllFilter(raw, toolName, ctx.compiledFilters) && displayTimeline,
```

(Yes, calling the helper twice is fine — it's pure and very cheap. If you prefer, extract `const passesAll = passesAllFilter(raw, toolName, ctx.compiledFilters)` above and use `passesAll && …` in both fields.)

- [ ] **Step 4.5: Run test, confirm it passes**

```bash
just test-client -- process-event
```

Expected: all three new tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add app/client/src/agents/claude-code/process-event.ts app/client/src/agents/claude-code/process-event.test.ts
git commit -m "feat: gate Claude Code events through passesAllFilter"
```

---

## Task 5: Apply the same gate in the `default` agent (used by codex)

**Files:**
- Modify: `app/client/src/agents/default/index.tsx`
- Test: `app/client/src/agents/default/index.test.tsx` (extend if exists, otherwise create)

- [ ] **Step 5.1: Inspect the default agent's `processEvent`**

```bash
sed -n '20,60p' app/client/src/agents/default/index.tsx
```

Confirm `processEvent` is the function exported from this file and that it currently sets `displayEventStream: true` and `displayTimeline: true` unconditionally (it does — see lines 43-44 in the current code).

- [ ] **Step 5.2: Add failing test**

Append a test that constructs the same context shape as Task 4 (you may DRY this later, but for now copy the `createCtx` helper from Task 4 into this test file too — different file, different scope) and assert that `processEvent` from `default/index` sets `displayEventStream: false` for a PostToolBatch raw event when the All filter is enabled.

```ts
import { describe, it, expect } from 'vitest'
import { processEvent } from './index'
import { compileFilters } from '@/lib/filters/compile'
import type { Filter } from '@/types'
import type { ProcessingContext } from '../types'

const ALL_FILTER: Filter = {
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  kind: 'default',
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

function ctx(filters: Filter[] = [ALL_FILTER]): ProcessingContext {
  return {
    dedupEnabled: true,
    compiledFilters: compileFilters(filters),
    getAgent: () => undefined,
    getGroupedEvents: () => [],
    getAgentEvents: () => [],
    getCurrentTurn: () => null,
    setCurrentTurn: () => {},
    clearCurrentTurn: () => {},
    getPendingGroup: () => null,
    setPendingGroup: () => {},
    clearPendingGroup: () => {},
    stashPendingAgentMeta: () => {},
    consumePendingAgentMeta: () => null,
    updateEvent: () => {},
  }
}

describe('default processEvent — All filter gating', () => {
  it('hides PostToolBatch events when default-all is enabled', () => {
    const raw = { id: 1, agentId: 'a', hookName: 'PostToolBatch', timestamp: 0, payload: {} }
    const { event } = processEvent(raw, ctx())
    expect(event.displayEventStream).toBe(false)
    expect(event.displayTimeline).toBe(false)
  })

  it('shows other events with default-all enabled', () => {
    const raw = { id: 1, agentId: 'a', hookName: 'UserPromptSubmit', timestamp: 0, payload: {} }
    const { event } = processEvent(raw, ctx())
    expect(event.displayEventStream).toBe(true)
    expect(event.displayTimeline).toBe(true)
  })
})
```

Save as `app/client/src/agents/default/index.test.tsx`.

- [ ] **Step 5.3: Run, confirm fail**

```bash
just test-client -- agents/default
```

Expected: fail.

- [ ] **Step 5.4: Modify `default/index.tsx`**

Add import at top:

```ts
import { passesAllFilter } from '@/lib/filters/all-filter'
```

Find the object literal that constructs the enriched event (it contains `displayEventStream: true` and `displayTimeline: true` near lines 43-44). Above the `return` for `processEvent`, compute:

```ts
const passesAll = passesAllFilter(raw, toolName, ctx.compiledFilters)
```

Then change:

```ts
    displayEventStream: true,
    displayTimeline: true,
```

to:

```ts
    displayEventStream: passesAll,
    displayTimeline: passesAll,
```

- [ ] **Step 5.5: Run, confirm pass**

```bash
just test-client -- agents/default
```

Expected: both tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add app/client/src/agents/default/index.tsx app/client/src/agents/default/index.test.tsx
git commit -m "feat: gate default-agent events through passesAllFilter"
```

---

## Task 6: Settings UI — sort, caption, editor presets

**Files:**
- Modify: `app/client/src/components/settings/filters-tab.tsx`
- Test: `app/client/src/components/settings/filters-tab.test.tsx`

The four UI changes:

1. **Sort `default-all` first** in the list.
2. **Caption** above the row in the filter list: "Hides events from the timeline and event stream. Excluded events still appear in raw logs."
3. **Hide Display, Combinator, and Color controls** in `FilterEditor` when the selected filter is `default-all`.
4. **Default `negate: true`** for new pattern rows added to `default-all` (the existing "+ Add pattern" button currently creates `{ target: 'hook', regex: '' }`).

- [ ] **Step 6.1: Inspect the existing list sort + editor**

```bash
sed -n '100,130p' app/client/src/components/settings/filters-tab.tsx
sed -n '370,420p' app/client/src/components/settings/filters-tab.tsx
sed -n '750,770p' app/client/src/components/settings/filters-tab.tsx
```

You're looking for:
- the comparator that orders the filter list (around lines 111-112: user kind first, then by name)
- the `FilterEditor` component definition (around line 373)
- the "+ Add pattern" button (around line 754)

- [ ] **Step 6.2: Add failing tests**

The existing `filters-tab.test.tsx` uses this pattern:
- A `renderWithQuery(ui)` helper wraps the component in a `QueryClientProvider`.
- A `beforeEach` resets `useFilterStore.setState({ filters: [], compiled: [], loaded: false, dirty: false })`.
- Each test seeds filters by calling `useFilterStore.setState({ filters: [...], loaded: true })` directly.

Reuse this. Add a new `describe('FiltersTab — All filter', ...)` block at the bottom of the file. Inside it, seed filters via the store. Example (adapt selectors to match the actual DOM produced by `FiltersTab`):

```ts
import type { Filter } from '@/types'

const defaultAll: Filter = {
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  kind: 'default',
  enabled: true,
  config: { role: 'all-exclusions' },
  createdAt: 0,
  updatedAt: 0,
}

const defaultTools: Filter = {
  id: 'default-tools',
  name: 'Tools',
  pillName: 'Tools',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PreToolUse$' }],
  kind: 'default',
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

describe('FiltersTab — All filter', () => {
  beforeEach(() => {
    useFilterStore.setState({
      filters: [defaultTools, defaultAll], // intentionally NOT first
      compiled: [],
      loaded: true,
      dirty: false,
    })
  })

  test('renders default-all first in the filter list', () => {
    renderWithQuery(<FiltersTab />)
    // Find filter list items. Use the same selector strategy the existing
    // tests use (look for the existing test "clicking + New filter creates
    // a user filter and selects it" to see what selector queries the list).
    // For example, if rows are buttons with the filter's name as text,
    // the first such button should read "All".
    const rows = screen.getAllByRole('button').filter((b) =>
      ['All', 'Tools'].includes(b.textContent ?? ''),
    )
    expect(rows[0]).toHaveTextContent('All')
  })

  test('shows the All-filter caption above the default-all row', () => {
    renderWithQuery(<FiltersTab />)
    expect(
      screen.getByText(/Hides events from the timeline and event stream/i),
    ).toBeInTheDocument()
  })

  test('hides Display, Combinator, and Color controls when editing default-all', () => {
    renderWithQuery(<FiltersTab />)
    fireEvent.click(screen.getByText('All'))
    expect(screen.queryByText(/^Display$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Combinator$/)).not.toBeInTheDocument()
    // ColorPicker renders a swatch button — see how the existing color test
    // queries it, and assert the same query returns nothing here.
    expect(screen.queryByText(/^Color$/)).not.toBeInTheDocument()
  })

  test('defaults new pattern rows to negate=true when editing default-all', () => {
    renderWithQuery(<FiltersTab />)
    fireEvent.click(screen.getByText('All'))
    fireEvent.click(screen.getByText('+ Add pattern'))
    // The negate flag for the freshly added row is the last "Negate" checkbox.
    // The existing pattern editor renders a checkbox with the title
    // "When checked, the pattern matches events whose target does NOT
    // match the regex" — see line ~717 in filters-tab.tsx. Use that.
    const negateBoxes = screen.getAllByTitle(
      /When checked, the pattern matches events whose target does NOT match the regex/i,
    )
    expect(negateBoxes[negateBoxes.length - 1]).toBeChecked()
  })
})
```

Before writing implementation, run the existing test file once (`just test-client -- filters-tab`) to confirm the test infrastructure is happy. If the selectors above don't match the rendered output, adjust them — the rule is to mirror selectors already used in the existing tests in this file.

- [ ] **Step 6.3: Run, confirm all four tests fail**

```bash
just test-client -- filters-tab
```

Expected: 4 failures.

- [ ] **Step 6.4: Implement the sort**

In `app/client/src/components/settings/filters-tab.tsx`, find the comparator (around line 111). Add an `ALL_FILTER_ID` constant import at top:

```ts
import { ALL_FILTER_ID } from '@/lib/filters/all-filter'
```

Then adjust the sort so `id === ALL_FILTER_ID` always comes first. Locate the existing comparator (around line 111):

```ts
    const ku = a.kind === 'user' ? 0 : 1
    const kv = b.kind === 'user' ? 0 : 1
```

Add a pre-check before it:

```ts
    if (a.id === ALL_FILTER_ID) return -1
    if (b.id === ALL_FILTER_ID) return 1
    const ku = a.kind === 'user' ? 0 : 1
    const kv = b.kind === 'user' ? 0 : 1
```

- [ ] **Step 6.5: Implement the caption**

The Primary list maps with `primaryFilters.map((f) => <Row .../>)`. Wrap the map so the caption renders above the `default-all` row. Find the existing block in `filters-tab.tsx` (around line ~138-148):

```tsx
primaryFilters.map((f) => (
  <Row
    key={f.id}
    f={effective(f)}
    selected={selectedId === f.id}
    modified={drafts.has(f.id)}
    onSelect={() => setSelectedId(f.id)}
  />
))
```

Replace with:

```tsx
primaryFilters.map((f) => (
  <Fragment key={f.id}>
    {f.id === ALL_FILTER_ID && (
      <p className="px-2 py-1 text-xs text-muted-foreground italic">
        Hides events from the timeline and event stream. Excluded events still appear in raw logs.
      </p>
    )}
    <Row
      f={effective(f)}
      selected={selectedId === f.id}
      modified={drafts.has(f.id)}
      onSelect={() => setSelectedId(f.id)}
    />
  </Fragment>
))
```

Add `Fragment` to the React import at top of file if it isn't already imported:

```ts
import { Fragment, useMemo, useState, useEffect, useRef } from 'react'
```

- [ ] **Step 6.6: Hide Display / Combinator / Color when editing default-all**

In the `FilterEditor` function (around line 373), grab the filter id:

```ts
const isAllFilter = filter.id === ALL_FILTER_ID
```

Find the JSX that renders the Display toggle, Combinator picker, and Color picker (search the file for `Display`, `Combinator`, and the ColorPicker import; both labeled controls and their containers should be findable). Wrap each one with `{!isAllFilter && (...)}`.

For example, if the current JSX is:

```tsx
<DisplayToggle value={display} onChange={...} />
```

change to:

```tsx
{!isAllFilter && <DisplayToggle value={display} onChange={...} />}
```

Repeat for the combinator and color picker.

- [ ] **Step 6.7: Default new pattern rows to `negate: true` for default-all**

Find the "+ Add pattern" button (around line 754). The handler currently does:

```ts
onClick={() => setDraft({ patterns: [...patterns, { target: 'hook', regex: '' }] })}
```

Change it to use `isAllFilter`:

```ts
onClick={() =>
  setDraft({
    patterns: [
      ...patterns,
      isAllFilter
        ? { target: 'hook', regex: '', negate: true }
        : { target: 'hook', regex: '' },
    ],
  })
}
```

- [ ] **Step 6.8: Run tests, confirm pass**

```bash
just test-client -- filters-tab
```

Expected: all four new tests pass.

- [ ] **Step 6.9: Commit**

```bash
git add app/client/src/components/settings/filters-tab.tsx app/client/src/components/settings/filters-tab.test.tsx
git commit -m "feat: special-case default-all editor (sort, caption, presets)"
```

---

## Task 7: Verify end-to-end

- [ ] **Step 7.1: Full check**

```bash
just check
```

Expected: all tests pass, formatting clean.

- [ ] **Step 7.2: Manual browser verification**

Start the dev environment (if not already running, `just dev`). Open the dashboard at the configured port. Click around an existing session that has `PostToolBatch` events.

Verify:
- The timeline no longer shows `PostToolBatch` dots overlapping their tool calls.
- The event stream no longer lists `PostToolBatch` rows.
- The static "All" pill button still highlights when no pill is selected, just as before.
- Open Settings > Filters. Confirm the "All" filter is the first row, with the caption above it. Click it — the editor shows the patterns list but not the Display / Combinator / Color controls.
- Click "+ Add pattern" in the All filter editor — the new row's "negate" flag is on.
- Open the logs modal (raw events) — `PostToolBatch` events are still visible there.
- Toggle the All filter off in Settings. Reload (or trigger a reprocess via the existing dirty-flag flow). `PostToolBatch` reappears in both timeline and event stream.

- [ ] **Step 7.3: Commit any small fixes from manual verification**

If browser verification surfaces issues, add a final cleanup commit per issue with a clear conventional message.

---

## Out of scope (follow-ups)

- Admission-time drop in `EventStore.processOne` for memory savings.
- Re-evaluating the All filter inside the deferred Pre/Post mutation path at `process-event.ts:311`. Currently we evaluate only at initial processing time. Affects only user-configured payload-target exclusions where the merged payload changes the match result. Not in scope for the burning need (`PostToolBatch`, hook-target).
- Curated "safe to exclude" hook list with warnings for structurally load-bearing types.
