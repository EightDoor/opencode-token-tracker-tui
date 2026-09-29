import { Plugin } from "@opencode/plugin"
import type { TrackerConfig, BudgetStatus, BudgetSpentSnapshot } from "./lib/shared.js"
import {
  DEFAULT_CONFIG,
  calculateCost,
  evaluateBudgetStatus,
  formatCost,
  getStartOfDay,
  getStartOfMonth,
  getStartOfWeek,
  hasBillableTokenUsage,
  validateConfig,
} from "./lib/shared.js"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs"
import { open, type FileHandle } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const CONFIG_FILE = process.env["TOKEN_TRACKER_CONFIG_FILE"]
  || join(CONFIG_DIR, "token-tracker.json")
const LOG_DIR = join(CONFIG_DIR, "logs", "token-tracker")
const LOG_FILE = process.env["TOKEN_TRACKER_LOG_FILE"]
  || join(LOG_DIR, "tokens.jsonl")

// ============================================================================
// Configuration
// ============================================================================

let config: TrackerConfig = DEFAULT_CONFIG
let configWarnings: string[] = []
let lastConfigLoadTime = 0
let lastConfigMtime = 0

function loadConfig(): TrackerConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, "utf-8")
      const raw = JSON.parse(content)
      const result = validateConfig(raw)
      configWarnings = result.warnings
      if (result.warnings.length > 0) {
        for (const w of result.warnings) console.warn(`[Token Tracker] config: ${w}`)
      }
      return result.config
    }
  } catch (err) {
    // File read or JSON parse error - use defaults
    const reason = err instanceof Error ? err.message : String(err)
    configWarnings = [`Failed to read config (${reason}), using defaults`]
    console.warn(`[Token Tracker] config: ${configWarnings[0]}`)
  }
  return DEFAULT_CONFIG
}

function ensureLatestConfig(): void {
  const now = Date.now()
  if (now - lastConfigLoadTime < 2000) {
    return
  }

  lastConfigLoadTime = now

  try {
    if (existsSync(CONFIG_FILE)) {
      const stat = statSync(CONFIG_FILE)
      const mtime = stat.mtimeMs
      if (mtime !== lastConfigMtime) {
        config = loadConfig()
        lastConfigMtime = mtime
      }
    }
  } catch {
    // Keep current config on error
  }
}




// ============================================================================
// Session Statistics
// ============================================================================

interface SessionStats {
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCost: number
  messageCount: number
  startTime: number
}

const sessionStats = new Map<string, SessionStats>()

function getOrCreateSessionStats(sessionId: string): SessionStats {
  if (!sessionStats.has(sessionId)) {
    sessionStats.set(sessionId, {
      totalInput: 0,
      totalOutput: 0,
      totalReasoning: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalCost: 0,
      messageCount: 0,
      startTime: Date.now(),
    })
  }
  return sessionStats.get(sessionId)!
}

// ============================================================================
// Deduplication
// ============================================================================

const seen = new Set<string>()

function isDuplicate(key: string): boolean {
  if (seen.has(key)) return true
  seen.add(key)
  
  // Cleanup old entries to prevent memory leak
  if (seen.size > 10000) {
    const entries = Array.from(seen)
    entries.slice(0, 5000).forEach(k => seen.delete(k))
  }
  
  return false
}

// ============================================================================
// Logging
// ============================================================================

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

function logJson(data: Record<string, unknown>) {
  ensureLogDir()
  const entry = JSON.stringify({ ...data, _ts: Date.now() }) + "\n"
  appendFileSync(LOG_FILE, entry)
}

// ============================================================================
// Budget Tracking (in-memory accumulator, avoids per-message JSONL reads)
// ============================================================================

interface BudgetTracker {
  dailySpent: number
  weeklySpent: number
  monthlySpent: number
  dayStart: number    // timestamp of current day start
  weekStart: number   // timestamp of current week start
  monthStart: number  // timestamp of current month start
  initialized: boolean
}

const budgetTracker: BudgetTracker = {
  dailySpent: 0,
  weeklySpent: 0,
  monthlySpent: 0,
  dayStart: 0,
  weekStart: 0,
  monthStart: 0,
  initialized: false,
}

/**
 * Load cost entries from JSONL since a given timestamp.
 * Used only during initialization and period rollovers.
 */
function loadCostsSince(since: number): number {
  if (!existsSync(LOG_FILE)) return 0

  let total = 0
  let fd: number | null = null
  try {
    fd = openSync(LOG_FILE, "r")
    const stat = statSync(LOG_FILE)
    const fileSize = stat.size

    const CHUNK_SIZE = 64 * 1024 // 64KB chunks
    const buffer = Buffer.alloc(CHUNK_SIZE)

    let filePos = fileSize
    let leftover = ""
    let shouldStop = false

    while (filePos > 0 && !shouldStop) {
      const readLength = Math.min(CHUNK_SIZE, filePos)
      filePos -= readLength

      readSync(fd, buffer, 0, readLength, filePos)

      const chunkStr = buffer.toString("utf8", 0, readLength) + leftover
      const lines = chunkStr.split("\n")

      // The leftmost line could be cut off, save it for the next chunk read to the left
      leftover = lines[0]

      // Iterate lines in reverse order (from end to start)
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i].trim()
        if (!line) continue

        try {
          const entry = JSON.parse(line)
          if (entry.type !== "tokens" || !entry.cost) continue

          if (entry._ts < since) {
            shouldStop = true
            break
          }

          total += entry.cost
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Include the very first line at the top
    if (!shouldStop && leftover.trim()) {
      try {
        const entry = JSON.parse(leftover.trim())
        if (entry.type === "tokens" && entry.cost && entry._ts >= since) {
          total += entry.cost
        }
      } catch {}
    }
  } catch {
    // 异常路径下放弃部分累加结果，与 1.5.5 之前的语义保持一致，避免下游基于偏小值做预算判断
    total = 0
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }

  return total
}

/**
 * Initialize budgetTracker from JSONL file (called once at plugin init).
 */
async function initBudgetTracker(): Promise<void> {
  const now = new Date()
  budgetTracker.dayStart = getStartOfDay(now)
  budgetTracker.weekStart = getStartOfWeek(now)
  budgetTracker.monthStart = getStartOfMonth(now)

  // Only load from file if budget is configured
  const budget = config.budget
  if (!budget.daily && !budget.weekly && !budget.monthly) {
    budgetTracker.initialized = true
    return
  }

  // Load once using the earliest period boundary
  const earliest = Math.min(
    budget.daily ? budgetTracker.dayStart : Infinity,
    budget.weekly ? budgetTracker.weekStart : Infinity,
    budget.monthly ? budgetTracker.monthStart : Infinity
  )

  if (!existsSync(LOG_FILE)) {
    budgetTracker.initialized = true
    return
  }

  let fileHandle: FileHandle | null = null
  try {
    const stat = statSync(LOG_FILE)
    const fileSize = stat.size

    fileHandle = await open(LOG_FILE, "r")

    const CHUNK_SIZE = 64 * 1024 // 64KB chunks
    const buffer = Buffer.alloc(CHUNK_SIZE)

    let filePos = fileSize
    let leftover = ""
    let shouldStop = false

    let daily = 0
    let weekly = 0
    let monthly = 0

    while (filePos > 0 && !shouldStop) {
      const readLength = Math.min(CHUNK_SIZE, filePos)
      filePos -= readLength

      const { bytesRead } = await fileHandle.read(buffer, 0, readLength, filePos)

      const chunkStr = buffer.toString("utf8", 0, bytesRead) + leftover
      const lines = chunkStr.split("\n")

      // The leftmost line could be cut off, save it for the next chunk read to the left
      leftover = lines[0]

      // Iterate lines in reverse order (from end to start)
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i].trim()
        if (!line) continue

        try {
          const entry = JSON.parse(line)
          if (entry.type !== "tokens" || !entry.cost) continue

          if (entry._ts < earliest) {
            shouldStop = true
            break
          }

          if (entry._ts >= budgetTracker.dayStart) daily += entry.cost
          if (entry._ts >= budgetTracker.weekStart) weekly += entry.cost
          if (entry._ts >= budgetTracker.monthStart) monthly += entry.cost
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Include the very first line at the top
    if (!shouldStop && leftover.trim()) {
      try {
        const entry = JSON.parse(leftover.trim())
        if (entry.type === "tokens" && entry.cost && entry._ts >= earliest) {
          if (entry._ts >= budgetTracker.dayStart) daily += entry.cost
          if (entry._ts >= budgetTracker.weekStart) weekly += entry.cost
          if (entry._ts >= budgetTracker.monthStart) monthly += entry.cost
        }
      } catch {}
    }

    budgetTracker.dailySpent = daily
    budgetTracker.weeklySpent = weekly
    budgetTracker.monthlySpent = monthly
  } catch (err) {
    // Keep budgetTracker at 0 on error
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close()
      } catch {}
    }
  }

  budgetTracker.initialized = true
}

/**
 * Accumulate cost into budgetTracker after a new token entry is logged.
 */
function accumulateBudget(cost: number): void {
  if (!budgetTracker.initialized) return

  const now = new Date()
  const currentDayStart = getStartOfDay(now)
  const currentWeekStart = getStartOfWeek(now)
  const currentMonthStart = getStartOfMonth(now)

  // Period rollover detection — reset and reload from file for accuracy
  if (currentDayStart !== budgetTracker.dayStart) {
    budgetTracker.dayStart = currentDayStart
    budgetTracker.dailySpent = loadCostsSince(currentDayStart)
  }
  if (currentWeekStart !== budgetTracker.weekStart) {
    budgetTracker.weekStart = currentWeekStart
    budgetTracker.weeklySpent = loadCostsSince(currentWeekStart)
  }
  if (currentMonthStart !== budgetTracker.monthStart) {
    budgetTracker.monthStart = currentMonthStart
    budgetTracker.monthlySpent = loadCostsSince(currentMonthStart)
  }

  budgetTracker.dailySpent += cost
  budgetTracker.weeklySpent += cost
  budgetTracker.monthlySpent += cost
}

function checkBudgetStatus(): BudgetStatus | null {
  const snapshot: BudgetSpentSnapshot = {
    dailySpent: budgetTracker.dailySpent,
    weeklySpent: budgetTracker.weeklySpent,
    monthlySpent: budgetTracker.monthlySpent,
  }
  return evaluateBudgetStatus(config.budget, snapshot, budgetTracker.initialized)
}

function formatBudgetMessage(status: BudgetStatus): string {
  const pct = Math.round(status.percentage * 100)
  const periodLabel = status.period.charAt(0).toUpperCase() + status.period.slice(1)
  return `${periodLabel}: ${formatCost(status.spent)}/${formatCost(status.limit)} (${pct}%)`
}

// ============================================================================
// V2 Event payload shapes
// ============================================================================

interface StepTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

interface StepEndedData {
  sessionID: string
  assistantMessageID: string
  finish?: string
  cost?: number
  tokens: StepTokens
}

interface StepStartedData {
  sessionID: string
  assistantMessageID: string
  agent?: string
  model?: { providerID: string; id: string }
}

interface StepFailedData {
  sessionID: string
  assistantMessageID: string
  finish?: string
  cost?: number
  tokens?: StepTokens
  error?: { message?: string; name?: string }
}

interface StepMeta {
  agent?: string
  provider?: string
  model?: string
}

interface SessionStatusData {
  sessionID?: string
  status?: { type?: string }
}

const stepMetaByMessage = new Map<string, StepMeta>()

function cleanupStaleStepMeta(): void {
  // Hard cap so dropped steps / step.failed without a started event can't grow forever
  if (stepMetaByMessage.size > 5000) {
    const overflow = stepMetaByMessage.size - 2500
    const keys = stepMetaByMessage.keys()
    for (let i = 0; i < overflow; i++) {
      const k = keys.next().value
      if (k === undefined) break
      stepMetaByMessage.delete(k)
    }
  }
}

function recordStepFinalized(
  sessionID: string,
  messageID: string,
  tokens: StepTokens | undefined,
  finish: string | undefined,
  failure: { message?: string; name?: string } | undefined,
): void {
  ensureLatestConfig()
  try {
    const input = tokens?.input ?? 0
    const output = tokens?.output ?? 0
    const reasoning = tokens?.reasoning ?? 0
    const cacheRead = tokens?.cache?.read ?? 0
    const cacheWrite = tokens?.cache?.write ?? 0

    // Always clear metadata so a lost step doesn't leak the entry
    const meta = stepMetaByMessage.get(messageID)
    stepMetaByMessage.delete(messageID)

    if (!hasBillableTokenUsage({ input, output, cacheRead, cacheWrite })) return

    const dedupeKey = `${messageID}-${input}-${output}-${cacheRead}-${cacheWrite}`
    if (isDuplicate(dedupeKey)) return

    const model = meta?.model ?? "unknown"
    const provider = meta?.provider ?? "unknown"
    // Local pricing is authoritative — user-provided provider/model overrides
    // (including zero-cost overrides for subscriptions) win over any value the
    // server attached to the event. Matches 1.x semantics.
    const cost = calculateCost(model, provider, input, output, cacheRead, cacheWrite, config)

    const stats = getOrCreateSessionStats(sessionID)
    stats.totalInput += input
    stats.totalOutput += output
    stats.totalReasoning += reasoning
    stats.totalCacheRead += cacheRead
    stats.totalCacheWrite += cacheWrite
    stats.totalCost += cost
    stats.messageCount += 1

    logJson({
      type: "tokens",
      sessionId: sessionID,
      messageId: messageID,
      role: "assistant",
      agent: meta?.agent,
      model,
      provider,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost,
      finish,
      failed: failure ? true : undefined,
      error: failure?.message,
    })

    accumulateBudget(cost)
  } finally {
    cleanupStaleStepMeta()
  }
}

const summarizedSessions = new Set<string>()

function recordSessionIdle(sessionID: string): void {
  ensureLatestConfig()
  const stats = sessionStats.get(sessionID)
  if (!stats || stats.messageCount === 0) return
  // Multiple completion events fire for one session — dedupe by (sessionID, messageCount)
  const dedupeKey = `${sessionID}-${stats.messageCount}`
  if (summarizedSessions.has(dedupeKey)) return
  summarizedSessions.add(dedupeKey)

  const totalTokens = stats.totalInput + stats.totalOutput
  logJson({
    type: "session-summary",
    sessionId: sessionID,
    totalInput: stats.totalInput,
    totalOutput: stats.totalOutput,
    totalReasoning: stats.totalReasoning,
    totalCacheRead: stats.totalCacheRead,
    totalCacheWrite: stats.totalCacheWrite,
    totalCost: stats.totalCost,
    messageCount: stats.messageCount,
    durationMin: Math.round((Date.now() - stats.startTime) / 1000 / 60),
    totalTokens,
  })
}

// ============================================================================
// V2 Plugin
// ============================================================================

/**
 * @internal — exported solely for unit tests of the V2 event handler logic.
 * Not part of the plugin's public contract.
 */
export const __testing = {
  recordStepFinalized,
  recordSessionIdle,
  loadConfig,
}

export default Plugin.define({
  id: "opencode-token-tracker-tui",
  async setup(ctx) {
    try {
      // Load config on plugin init (with validation)
      config = loadConfig()
      lastConfigLoadTime = Date.now()
      if (existsSync(CONFIG_FILE)) {
        lastConfigMtime = statSync(CONFIG_FILE).mtimeMs
      }

      // Initialize in-memory budget tracker (reads JSONL once)
      await initBudgetTracker()

      const controller = new AbortController()

      // ctx.location is the instance's load location, NOT every event's origin.
      // Filter events to only those produced at this location, otherwise multiple
      // workspace / project instances of the plugin would cross-process each other.
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

      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              if (!sameLocation(event)) continue

              if (event.type === "session.step.started") {
                const data = (event as { data?: StepStartedData }).data
                if (!data?.sessionID || !data?.assistantMessageID) continue
                const model = data.model
                stepMetaByMessage.set(data.assistantMessageID, {
                  agent: data.agent,
                  provider: model?.providerID,
                  model: model?.id,
                })
                continue
              }

              if (event.type === "session.step.ended") {
                const data = (event as { data?: StepEndedData }).data
                if (!data?.sessionID || !data?.assistantMessageID) continue
                recordStepFinalized(data.sessionID, data.assistantMessageID, data.tokens, data.finish, undefined)
                continue
              }

              // V2 also publishes a separate failure event per step — charge
              // any tokens the provider already billed before failing.
              if (event.type === "session.step.failed") {
                const data = (event as { data?: StepFailedData }).data
                if (!data?.sessionID || !data?.assistantMessageID) continue
                recordStepFinalized(
                  data.sessionID,
                  data.assistantMessageID,
                  data.tokens,
                  data.finish,
                  data.error,
                )
                continue
              }

              if (
                event.type === "session.status" ||
                event.type === "session.execution.succeeded" ||
                event.type === "session.execution.failed"
              ) {
                const data = (event as { data?: SessionStatusData }).data
                const sessionID = data?.sessionID
                if (!sessionID) continue
                if (event.type === "session.status") {
                  const status = data?.status?.type
                  if (status !== "idle") continue
                }
                recordSessionIdle(sessionID)
                continue
              }
            } catch (err) {
              console.error("[Token Tracker] event handler error:", err)
            }
          }
        } catch (err) {
          if ((err as { name?: string })?.name !== "AbortError") {
            console.error("[Token Tracker] event subscription error:", err)
          }
        }
      })()

      return () => controller.abort()
    } catch (err) {
      console.error("[Token Tracker] Initialization failed:", err)
      return () => {}
    }
  },
})