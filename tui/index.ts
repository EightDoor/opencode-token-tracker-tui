// Import from `@opencode/plugin/tui/plugin` directly. The package root
// `@opencode/plugin/tui` re-exports a Solid component that transitively
// imports `solid-js`, which is an OpenCode runtime dependency and is not
// bundled with this package. Importing the package root would force
// consumers and our test runner to resolve `solid-js`. The `define`
// helper is exported from the `./plugin` subpath without side effects.
import { define } from "@opencode/plugin/tui/plugin"
import type { Context } from "@opencode/plugin/tui/plugin"
import { jsx } from "@opentui/solid/jsx-runtime"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_CONFIG,
  formatCost,
  formatTokens,
  getStartOfDay,
  getStartOfMonth,
  getStartOfWeek,
  hasBillableTokenUsage,
  validateConfig,
  type TrackerConfig,
} from "../lib/shared.js"

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const CONFIG_FILE = process.env["TOKEN_TRACKER_CONFIG_FILE"]
  || join(CONFIG_DIR, "token-tracker.json")
const LOG_DIR = join(CONFIG_DIR, "logs", "token-tracker")
const LOG_FILE = process.env["TOKEN_TRACKER_LOG_FILE"]
  || join(LOG_DIR, "tokens.jsonl")

let config: TrackerConfig = DEFAULT_CONFIG
let configWarnings: string[] = []
let lastConfigLoadTime = 0
let lastConfigMtime = 0

function loadConfig(): void {
  lastConfigLoadTime = Date.now()
  try {
    if (!existsSync(CONFIG_FILE)) {
      config = DEFAULT_CONFIG
      configWarnings = []
      lastConfigMtime = 0
      return
    }
    const mtime = statSync(CONFIG_FILE).mtimeMs
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    const result = validateConfig(raw)
    config = result.config
    configWarnings = result.warnings
    lastConfigMtime = mtime
    if (result.warnings.length > 0) {
      for (const w of result.warnings) console.warn(`[Token Tracker TUI] config: ${w}`)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[Token Tracker TUI] config: failed to read (${reason}), keeping previous`)
  }
}

function reloadConfigIfChanged(): void {
  const now = Date.now()
  if (now - lastConfigLoadTime < 2000) return
  lastConfigLoadTime = now
  try {
    if (!existsSync(CONFIG_FILE)) {
      if (lastConfigMtime === 0 && config === DEFAULT_CONFIG) return
      config = DEFAULT_CONFIG
      configWarnings = []
      lastConfigMtime = 0
      return
    }
    const mtime = statSync(CONFIG_FILE).mtimeMs
    if (mtime === lastConfigMtime) return
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    const result = validateConfig(raw)
    config = result.config
    configWarnings = result.warnings
    lastConfigMtime = mtime
    if (result.warnings.length > 0) {
      for (const w of result.warnings) console.warn(`[Token Tracker TUI] config: ${w}`)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[Token Tracker TUI] config: failed to read (${reason}), keeping previous`)
  }
}

// ============================================================================
// Today snapshot
// ============================================================================

interface TokenEntry {
  type?: string
  _ts?: number
  sessionId?: string
  messageId?: string
  model?: string
  provider?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

interface ModelAggregate {
  model: string
  provider: string
  tokens: number
  cost: number
  messages: number
}

/**
 * Per-period aggregates. The total tokens field is input + output (matches
 * the historic sidebar.footer line) so legacy formatters keep working
 * against `tokens`. Callers that need the full token accounting (input /
 * output / cacheRead / cacheWrite) read the individual fields.
 */
interface PeriodAggregate {
  since: number
  label: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  cost: number
  messages: number
  byModel: ModelAggregate[]
  firstEntryAt?: number
  lastEntryAt?: number
  byModelMap: Map<string, ModelAggregate>
}

interface PeriodSnapshot {
  today: PeriodAggregate
  week: PeriodAggregate
  month: PeriodAggregate
  refreshedAt: number
  logExists: boolean
}

type TodaySnapshot = PeriodSnapshot

/**
 * Coerce a possibly-missing or non-numeric field into a non-negative finite
 * value. Anything else (string concat, NaN, object) is dropped to 0 so a
 * malformed JSONL line can never poison the aggregates or break page
 * rendering (padEnd/toFixed on NaN throws).
 */
function sanitizeTokenNum(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return value
}

function sanitizeCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return value
}

function sanitizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function emptyPeriod(since: number, label: string): PeriodAggregate {
  return {
    since,
    label,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    cost: 0,
    messages: 0,
    byModel: [],
    byModelMap: new Map(),
  }
}

function accumulatePeriod(
  agg: PeriodAggregate,
  entry: TokenEntry,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): void {
  const cost = sanitizeCost(entry.cost)
  const model = sanitizeString(entry.model, "unknown")
  const provider = sanitizeString(entry.provider, "unknown")
  const totalTokens = input + output

  agg.input += input
  agg.output += output
  agg.cacheRead += cacheRead
  agg.cacheWrite += cacheWrite
  agg.tokens += totalTokens
  agg.cost += cost
  agg.messages += 1
  if (entry._ts !== undefined) {
    if (agg.firstEntryAt === undefined || entry._ts < agg.firstEntryAt) {
      agg.firstEntryAt = entry._ts
    }
    if (agg.lastEntryAt === undefined || entry._ts > agg.lastEntryAt) {
      agg.lastEntryAt = entry._ts
    }
  }

  const modelKey = `${provider}::${model}`
  let modelRow = agg.byModelMap.get(modelKey)
  if (!modelRow) {
    modelRow = { model, provider, tokens: 0, cost: 0, messages: 0 }
    agg.byModelMap.set(modelKey, modelRow)
  }
  modelRow.tokens += totalTokens
  modelRow.cost += cost
  modelRow.messages += 1
}

/**
 * Read token usage for today / this week / this month from the JSONL log.
 * Uses reverse 64KB chunking so the read cost is O(earliest period bytes),
 * not O(all-time bytes). A single scan populates all three period buckets.
 */
function readTodaySnapshot(now: Date = new Date()): TodaySnapshot {
  const todaySince = getStartOfDay(now)
  const weekSince = getStartOfWeek(now)
  const monthSince = getStartOfMonth(now)
  const refreshedAt = Date.now()

  const empty: TodaySnapshot = {
    today: emptyPeriod(todaySince, "Today"),
    week: emptyPeriod(weekSince, "This Week"),
    month: emptyPeriod(monthSince, "This Month"),
    refreshedAt,
    logExists: existsSync(LOG_FILE),
  }

  if (!existsSync(LOG_FILE)) {
    return empty
  }
  let fileSize: number
  try {
    fileSize = statSync(LOG_FILE).size
  } catch (err) {
    console.warn("[Token Tracker TUI] today snapshot stat failed:", err)
    return empty
  }
  if (fileSize === 0) return empty

  // Walk back until we leave every period bucket. We must use the earliest
  // since across all three periods — weekSince can precede monthSince when
  // the current week started in the previous calendar month (e.g. Tue
  // 2026-09-01 belongs to week starting Mon 2026-08-31).
  const earliestSince = Math.min(todaySince, weekSince, monthSince)
  const periods = [empty.week, empty.month]
  // Note: today is included via the >= since comparison below; no separate bucket needed.

  const CHUNK_SIZE = 64 * 1024
  const buffer = Buffer.alloc(CHUNK_SIZE)
  let fd: number | null = null
  try {
    fd = openSync(LOG_FILE, "r")
    let filePos = fileSize
    let leftover = ""
    let shouldStop = false

    while (filePos > 0 && !shouldStop) {
      const readLength = Math.min(CHUNK_SIZE, filePos)
      filePos -= readLength
      readSync(fd, buffer, 0, readLength, filePos)
      const chunkStr = buffer.toString("utf8", 0, readLength) + leftover
      const lines = chunkStr.split("\n")
      leftover = lines[0] ?? ""

      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i]!.trim()
        if (!line) continue
        let entry: TokenEntry
        try {
          const parsed: unknown = JSON.parse(line)
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
          entry = parsed as TokenEntry
        } catch {
          continue
        }
        if (entry.type !== "tokens") continue
        if (!entry._ts || entry._ts < earliestSince) {
          shouldStop = true
          break
        }
        const input = sanitizeTokenNum(entry.input)
        const output = sanitizeTokenNum(entry.output)
        const cacheRead = sanitizeTokenNum(entry.cacheRead)
        const cacheWrite = sanitizeTokenNum(entry.cacheWrite)
        if (!hasBillableTokenUsage({ input, output, cacheRead, cacheWrite })) continue

        if (entry._ts >= todaySince) {
          accumulatePeriod(empty.today, entry, input, output, cacheRead, cacheWrite)
        }
        for (const period of periods) {
          if (entry._ts >= period.since) {
            accumulatePeriod(period, entry, input, output, cacheRead, cacheWrite)
          }
        }
      }
    }

    if (!shouldStop && leftover.trim()) {
      try {
        const parsed: unknown = JSON.parse(leftover.trim())
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("non-object JSON entry")
        }
        const entry = parsed as TokenEntry
        if (
          entry.type === "tokens"
          && entry._ts
          && entry._ts >= earliestSince
          && hasBillableTokenUsage({
            input: sanitizeTokenNum(entry.input),
            output: sanitizeTokenNum(entry.output),
            cacheRead: sanitizeTokenNum(entry.cacheRead),
            cacheWrite: sanitizeTokenNum(entry.cacheWrite),
          })
        ) {
          const input = sanitizeTokenNum(entry.input)
          const output = sanitizeTokenNum(entry.output)
          const cacheRead = sanitizeTokenNum(entry.cacheRead)
          const cacheWrite = sanitizeTokenNum(entry.cacheWrite)
          if (entry._ts >= todaySince) {
            accumulatePeriod(empty.today, entry, input, output, cacheRead, cacheWrite)
          }
          for (const period of periods) {
            if (entry._ts >= period.since) {
              accumulatePeriod(period, entry, input, output, cacheRead, cacheWrite)
            }
          }
        }
      } catch {
        // ignore malformed first line
      }
    }
  } catch (err) {
    console.warn("[Token Tracker TUI] today snapshot read failed:", err)
    return empty
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }

  for (const period of [empty.today, ...periods]) {
    period.byModel = [...period.byModelMap.values()].sort((a, b) => b.cost - a.cost)
  }

  return empty
}

// ============================================================================
// Per-step model/provider lookup
// ============================================================================

// ============================================================================
// Event payload shapes
// ============================================================================

interface StepStartedData {
  sessionID: string
  assistantMessageID: string
  agent?: string
  model?: { providerID: string; id: string }
}

interface StepEndedData {
  sessionID: string
  assistantMessageID: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

interface StepFailedData {
  sessionID: string
  assistantMessageID: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

interface SessionStatusData {
  sessionID?: string
  status?: { type?: string }
}

// ============================================================================
// Renderers — slot/page render functions MUST return a single JSX element.
// Returning a bare string crashes the TUI with "Orphan text error:
// must have a <text> as a parent".
// ============================================================================

function pct(part: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((part / total) * 100)}%`
}

function formatTimeAgo(ts: number, now: number): string {
  const deltaSec = Math.max(0, Math.round((now - ts) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const minutes = Math.round(deltaSec / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatStatsPage(snap: TodaySnapshot): string {
  // Compact summary appended to the TUI sidebar. Designed to be readable
  // at a glance — three rows for today/week/month, plus the top models
  // today and a cache-hit hint. No tables, no provider breakdown, no
  // source metadata; users who want the full picture run
  // `opencode-tokens`.
  const t = snap.today
  const w = snap.week
  const m = snap.month
  const refreshedAt = snap.refreshedAt
  const refreshed = snap.logExists ? formatTimeAgo(refreshedAt, Date.now()) : "no log"

  const lines: string[] = []
  lines.push(`Token Tracker · ${refreshed}`)
  lines.push("─".repeat(36))
  lines.push(`${"today".padEnd(6)} ${formatTokens(t.tokens).padStart(7)} tok  ${formatCost(t.cost).padStart(8)}  ${String(t.messages).padStart(3)} msgs`)
  lines.push(`${"week".padEnd(6)} ${formatTokens(w.tokens).padStart(7)} tok  ${formatCost(w.cost).padStart(8)}  ${String(w.messages).padStart(3)} msgs`)
  lines.push(`${"month".padEnd(6)} ${formatTokens(m.tokens).padStart(7)} tok  ${formatCost(m.cost).padStart(8)}  ${String(m.messages).padStart(3)} msgs`)

  if (t.messages > 0) {
    const hit = pct(t.cacheRead, t.cacheRead + t.input)
    lines.push("")
    lines.push(`cache hit ${hit}`)
    // Top N models today — sorted by cost desc (already sorted by the
    // scan). N is capped to keep the sidebar compact; the CLI exposes
    // the full breakdown for users who want more.
    const TOP_N = 5
    const top = t.byModel.slice(0, TOP_N)
    if (top.length > 0) {
      lines.push("top models (today)")
      const total = t.cost > 0 ? t.cost : 1
      top.forEach((row, i) => {
        lines.push(`  ${String(i + 1)}. ${row.model} ${formatCost(row.cost)} (${pct(row.cost, total)})`)
      })
      if (t.byModel.length > TOP_N) {
        lines.push(`  …+${t.byModel.length - TOP_N} more — run \`opencode-tokens today --by model\``)
      }
    }
  }

  return lines.join("\n")
}

// ============================================================================
// textNode — return a Solid lazy element that constructs an OpenTUI <text>
// Renderable. We pass a Solid component (not the intrinsic "text" string)
// to `jsx()` so that:
//   1. `jsx()` returns a `createComponent` result instead of calling
//      `createElement("text")` eagerly. `createElement` requires the
//      OpenTUI RendererContext, which is only available inside the host's
//      slot/page wrapper — not during setup().
//   2. The intrinsic <text> element is only constructed when the host
//      invokes render(), at which point RendererContext is on the stack.
//
// Returning a bare string crashes with "Orphan text error: must have a
// <text> as a parent". Returning a plain {type,props} object crashes with
// "remove expects a renderable child object". A Solid component is the
// only shape the host accepts.
// ============================================================================

function TextNode(props: { children?: unknown }): JSX.Element {
  return jsx("text", { children: props.children })
}

function textNode(content: string): JSX.Element {
  // jsx(fn, props) returns a Solid lazy element. <TextNode> is invoked
  // later by the host, which has the OpenTUI RendererContext in scope.
  return jsx(TextNode, { children: content })
}

// ============================================================================
// Plugin
// ============================================================================

export default define({
  id: "opencode-token-tracker-tui",
  setup(ctx: Context) {
    loadConfig()

    // panel.enabled=false short-circuits the entire plugin: no log reads,
    // no slot registrations, no event subscriptions.
    if (!(config.panel?.enabled ?? true)) {
      return
    }

    const myLocation = ctx.location
    const sameLocation = (event: unknown): boolean => {
      if (!myLocation) return true
      const loc = (event as { location?: { directory?: string; workspaceID?: string } | null })
        .location
      if (!loc) return false
      if (loc.directory !== myLocation.directory) return false
      if (myLocation.workspaceID !== undefined && loc.workspaceID !== myLocation.workspaceID) {
        return false
      }
      return true
    }

    // Reactive state. Reads inside Solid memo/effect will re-run when these
    // signals change, so the host re-renders the slot/page content.
    const nowInit = new Date()
    const placeholder: TodaySnapshot = {
      today: emptyPeriod(getStartOfDay(nowInit), "Today"),
      week: emptyPeriod(getStartOfWeek(nowInit), "This Week"),
      month: emptyPeriod(getStartOfMonth(nowInit), "This Month"),
      refreshedAt: Date.now(),
      logExists: existsSync(LOG_FILE),
    }
    const [snapshot, setSnapshot] = createSignal<TodaySnapshot>(placeholder, { equals: false })

    // Throttled refresh of the today snapshot from the JSONL log. The
    // signal update notifies any reactive readers (none today, but the
    // pattern leaves room for future UI subscribers).
    const refreshMs = Math.max(1, config.panel?.refreshSeconds ?? 5) * 1000
    let lastRefreshAt = 0
    const refreshSnapshot = (force: boolean = false): void => {
      const now = Date.now()
      if (!force && now - lastRefreshAt < refreshMs) return
      lastRefreshAt = now
      try {
        setSnapshot(readTodaySnapshot())
      } catch (err) {
        console.warn("[Token Tracker TUI] snapshot refresh failed:", err)
      }
    }

    // Initial snapshot read.
    try {
      setSnapshot(readTodaySnapshot())
      lastRefreshAt = Date.now()
    } catch (err) {
      console.warn("[Token Tracker TUI] initial snapshot failed:", err)
    }

    const cleanups: Array<() => void> = []
    const teardown = () => {
      while (cleanups.length > 0) {
        const off = cleanups.pop()!
        try { off() } catch { /* ignore */ }
      }
    }

    // ---- Sidebar content — `sidebar.content` is the slot tree inside the
    // TUI's right sidebar. Appending here places a compact token summary
    // below whatever content the host already renders; we do NOT touch
    // `session.panel` because opening that slot replaces the entire right
    // pane and clobbers the user's session view. Registered inside
    // try/catch so partial registration failure rolls back already-registered
    // cleanups.
    try {
      cleanups.push(
        ctx.ui.slot({
          append: "sidebar.content",
          // sidebar.content input carries { sessionID }. We render the same
          // snapshot for every sidebar (cross-session totals live in the
          // log file); the sessionID is ignored.
          render: () => textNode(formatStatsPage(snapshot())),
        }),
      )
    } catch (err) {
      teardown()
      throw err
    }

    // ---- Event subscriptions ---------------------------------
    const onStepStarted = (event: unknown): void => {
      if (!sameLocation(event)) return
      const data = (event as { data?: StepStartedData }).data
      if (!data?.sessionID || !data?.assistantMessageID) return
    }

    const onStepEnded = (event: unknown): void => {
      if (!sameLocation(event)) return
      const data = (event as { data?: StepEndedData | StepFailedData }).data
      if (!data?.sessionID || !data?.assistantMessageID) return
      const tokens = data.tokens
      const input = tokens?.input ?? 0
      const output = tokens?.output ?? 0
      const cacheRead = tokens?.cache?.read ?? 0
      const cacheWrite = tokens?.cache?.write ?? 0
      if (!hasBillableTokenUsage({ input, output, cacheRead, cacheWrite })) return

      // The server plugin writes the canonical entry to tokens.jsonl; we
      // only need to refresh the snapshot so the content panel reflects it.
      refreshSnapshot()
    }

    const onSessionStatus = (event: unknown): void => {
      if (!sameLocation(event)) return
      const data = (event as { data?: SessionStatusData }).data
      if (!data?.sessionID) return
      if (data.status?.type !== "idle") return
      // The server plugin writes session-summary rows on idle; the next
      // throttled refresh will pick them up. We do not force-refresh here
      // because the snapshot now spans the full month and a forced read
      // would amplify disk I/O on every idle transition.
      refreshSnapshot()
    }

    try {
      cleanups.push(ctx.data.on("session.step.started", onStepStarted))
      cleanups.push(ctx.data.on("session.step.ended", onStepEnded))
      cleanups.push(ctx.data.on("session.step.failed", onStepEnded))
      cleanups.push(ctx.data.on("session.status", onSessionStatus))
    } catch (err) {
      teardown()
      throw err
    }

    return teardown
  },
})

/**
 * @internal — exported solely for unit tests of the TUI plugin. Not part of
 * the plugin's public contract. Resets every piece of module-level state
 * (config cache) so test runs are isolated.
 */
export const __testing = {
  resetState(): void {
    config = DEFAULT_CONFIG
    configWarnings = []
    lastConfigLoadTime = 0
    lastConfigMtime = 0
  },
}