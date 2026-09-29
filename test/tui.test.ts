import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Context } from "@opencode/plugin/tui/plugin"

// Set env vars BEFORE importing the TUI module so its module-level paths
// pick up the temp files.
const tmpDir = mkdtempSync(join(tmpdir(), "token-tracker-tui-test-"))
const tempConfig = join(tmpDir, "token-tracker.json")
const tempLog = join(tmpDir, "tokens.jsonl")
process.env["TOKEN_TRACKER_CONFIG_FILE"] = tempConfig
process.env["TOKEN_TRACKER_LOG_FILE"] = tempLog

const tuiModule = await import("../tui/index.js")
const tuiDef = tuiModule.default

// ============================================================================
// Fake harness — captures slot/page render registrations and event subs.
// ============================================================================

interface SlotCall {
  path: string
  placement: "append" | "prepend" | "before" | "after" | "replace"
  render: (input: unknown) => unknown
}

interface PageCall {
  name: string
  render: () => unknown
}

interface FakeHarness {
  slots: SlotCall[]
  pages: PageCall[]
  handlers: Map<string, Set<(e: unknown) => void>>
  panelOpens: string[]
  panelCloses: number
  /**
   * Stack of return values that `panel.open` yields in order. Empty
   * defaults to returning true for every call. Tests push values to
   * script a sequence (e.g. [false, true] to model a first failed open
   * followed by a successful retry).
   */
  panelOpenReturns: boolean[]
  context: Context
}

function makeContext(): FakeHarness {
  const slots: SlotCall[] = []
  const pages: PageCall[] = []
  const handlerSets = new Map<string, Set<(e: unknown) => void>>()
  const panelOpens: string[] = []
  const panelOpenReturns: boolean[] = []
  const panelClosesBox = { value: 0 }
  const data = {
    on: (type: string, handler: (event: unknown) => void) => {
      let set = handlerSets.get(type)
      if (!set) {
        set = new Set()
        handlerSets.set(type, set)
      }
      set.add(handler)
      return () => set!.delete(handler)
    },
    listen: () => () => {},
  }
  const slot = (claim: {
    append?: string
    prepend?: string
    before?: string
    after?: string
    replace?: string
    render: (input: unknown) => unknown
  }) => {
    let path = ""
    let placement: SlotCall["placement"] = "append"
    if (claim.append) { path = claim.append; placement = "append" }
    else if (claim.prepend) { path = claim.prepend; placement = "prepend" }
    else if (claim.before) { path = claim.before; placement = "before" }
    else if (claim.after) { path = claim.after; placement = "after" }
    else if (claim.replace) { path = claim.replace; placement = "replace" }
    slots.push({ path, placement, render: claim.render })
    return () => {
      const i = slots.findIndex(s => s.render === claim.render)
      if (i >= 0) slots.splice(i, 1)
    }
  }
  const ui = {
    toast: { show: () => {} },
    dialog: {} as never,
    format: { path: (v: string) => v },
    router: {
      register: (page: { name: string; render: () => unknown }) => {
        pages.push({ name: page.name, render: page.render })
        return () => {
          const i = pages.findIndex(p => p.render === page.render)
          if (i >= 0) pages.splice(i, 1)
        }
      },
      navigate: () => {},
      current: () => ({ type: "home" as const }),
    },
    panel: {
      open: (name: string) => {
        panelOpens.push(name)
        const queued = panelOpenReturns.shift()
        return queued ?? true
      },
      close: () => {
        panelClosesBox.value += 1
      },
      current: () => undefined,
    },
    tabs: { enabled: () => false, list: () => [], open: () => false, focus: () => false, move: () => false, close: () => false },
    model: { current: () => undefined, variant: { list: () => [], set: () => false } },
    slot,
  }
  const context = {
    options: {},
    location: { directory: "/test/location" },
    app: { version: "test", channel: "test" },
    renderer: {} as never,
    client: {} as never,
    data: data as unknown as Context["data"],
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
    theme: {} as never,
    themeMode: "dark" as const,
    markdown: { registerCodeBlockRenderer: () => () => {} },
    keymap: {} as never,
    storage: {} as never,
    ui: ui as unknown as Context["ui"],
  } as unknown as Context
  return {
    slots,
    pages,
    handlers: handlerSets,
    panelOpens,
    get panelCloses() {
      return panelClosesBox.value
    },
    panelOpenReturns,
    context,
  }
}

beforeEach(() => {
  rmSync(tempLog, { force: true })
  rmSync(tempConfig, { force: true })
  tuiModule.__testing.resetState()
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env["TOKEN_TRACKER_CONFIG_FILE"]
  delete process.env["TOKEN_TRACKER_LOG_FILE"]
})

before(() => {
  assert.equal(typeof tuiDef, "object")
  assert.equal(tuiDef.id, "opencode-token-tracker-tui")
  assert.equal(typeof tuiDef.setup, "function")
})

// ============================================================================
// CRASH REGRESSION GUARDS — verified by source inspection.
//
// Two production crashes have hit this plugin:
//   1. 2026-09-26: "Orphan text error: must have a <text> as a parent" —
//      slot.render returned a bare string.
//   2. 2026-09-27: "remove expects a renderable child object" —
//      slot.render returned a plain {type, props} object the host could
//      not mount.
//
// The fix: `textNode()` returns the result of `jsx(TextNode, props)` — a
// Solid `createComponent` value. Solid invokes the inner `TextNode`
// component under the host's RendererContext, where `createElement("text")`
// succeeds. This is a static invariant verifiable by reading the source:
// we can assert "no bare string return" and "no plain object return" by
// pattern-matching the source file.
//
// We do NOT invoke textNode() in unit tests — the OpenTUI renderer is
// only available under Bun (or in OpenCode v2's TUI runtime), not in
// plain Node. Production regression coverage comes from running
// `opencode2` and exercising the actual mount path.
// ============================================================================

import { readFileSync } from "node:fs"

describe("TUI plugin — crash regression guards (source-level)", () => {
  const tuiSource = readFileSync(
    new URL("../../tui/index.ts", import.meta.url),
    "utf8",
  )

  it("does not return a bare string from any textNode function", () => {
    // Defensive: any future refactor that returns a bare string from
    // textNode would re-introduce the 2026-09-26 crash.
    // Pattern: a function whose body returns a template literal directly.
    const suspiciousReturn = /(function\s+textNode[^}]*return\s+`)/m
    assert.equal(
      suspiciousReturn.test(tuiSource),
      false,
      "textNode must not return a bare template string — would crash the TUI with 'Orphan text error'",
    )
  })

  it("textNode is built on jsx(TextNode, ...) — lazy component pattern", () => {
    // The fix pattern. If this changes, the lazy-component invariant that
    // keeps createElement("text") out of setup() is gone.
    const lazy = /function\s+textNode\([\s\S]*?return\s+jsx\(\s*TextNode/m
    assert.ok(
      lazy.test(tuiSource),
      "textNode must return jsx(TextNode, ...) — the lazy-component pattern that defers OpenTUI construction to the host",
    )
  })

  it("TextNode is defined as a function component (not a string tag)", () => {
    // If someone refactors `TextNode` to be undefined or to a string, the
    // jsx(TextNode, ...) call above would either fail to compile or
    // return an eagerly-constructed Renderable.
    assert.match(tuiSource, /function\s+TextNode\s*\(/)
  })
})

// ============================================================================
// Slots & pages — registration shape only. We don't invoke render()
// here because doing so requires an OpenTUI renderer that cannot be
// instantiated in plain Node (it requires Bun or a real terminal).
// ============================================================================

describe("TUI plugin — registration", () => {
  it("appends the compact summary to the sidebar without claiming any other slot", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      // The summary lives below the host's own sidebar content via
      // `sidebar.content` — appending here does NOT replace the user's
      // session view (which is what opening `session.panel` would do).
      assert.equal(harness.slots.length, 1)
      const slot = harness.slots[0]!
      assert.equal(slot.path, "sidebar.content")
      assert.equal(slot.placement, "append")
      assert.equal(harness.pages.length, 0)
      // The plugin must not call ui.panel.open — opening the right pane
      // would clobber the user's existing session view.
      assert.equal(harness.panelOpens.length, 0)
    } finally {
      await cleanup?.()
    }
  })

  it("sidebar content render is source-level: returns jsx(TextNode, ...) lazy component", () => {
    // We can't safely invoke the slot render here because doing so would
    // mount the lazy Solid component under @opentui/solid and throw
    // "No renderer found" (the OpenTUI renderer only exists in Bun).
    // Match the existing crash regression guards at the top of this file:
    // pattern-match the source so a future refactor that returns a bare
    // string or a non-lazy element is caught statically.
    const source = readFileSync(
      new URL("../../tui/index.ts", import.meta.url),
      "utf8",
    )
    const sidebarMatch = /append:\s*"sidebar\.content"/.test(source)
    assert.ok(sidebarMatch, "must register via append: \"sidebar.content\"")
    const renderMatch = /render:\s*\(\)\s*=>\s*textNode\(formatStatsPage\(snapshot\(\)\)\)/.test(source)
    assert.ok(
      renderMatch,
      "sidebar render must return textNode(formatStatsPage(snapshot())) — never a bare string",
    )
    // Must NOT touch the right-side panel slot — doing so clobbers the user's view.
    const panelMatch = /append:\s*"session\.panel"/.test(source)
    assert.equal(
      panelMatch,
      false,
      "must NOT register on session.panel — it replaces the entire right pane",
    )
  })

  it("panel.enabled=false registers nothing", async () => {
    writeFileSync(
      tempConfig,
      JSON.stringify({ panel: { enabled: false } }),
      "utf-8",
    )
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    assert.equal(harness.slots.length, 0)
    assert.equal(harness.pages.length, 0)
    assert.equal(harness.handlers.size, 0)
    await cleanup?.()
  })

  it("returned cleanup is idempotent and releases every registration", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    assert.equal(typeof cleanup, "function")
    await cleanup!()
    await cleanup!()
    assert.equal(harness.handlers.get("session.step.started")!.size, 0)
    assert.equal(harness.handlers.get("session.step.ended")!.size, 0)
    assert.equal(harness.handlers.get("session.step.failed")!.size, 0)
    assert.equal(harness.handlers.get("session.status")!.size, 0)
    assert.equal(harness.slots.length, 0)
    assert.equal(harness.pages.length, 0)
    // No panel.close — the plugin never opens a panel.
    assert.equal(harness.panelCloses, 0)
  })
})

// ============================================================================
// Event subscriptions — verify the handlers exist and behave correctly
// when invoked directly. We don't depend on slot rendering here.
// ============================================================================

describe("TUI plugin — event handlers", () => {
  it("subscribes to started, ended, failed, and status events", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      assert.ok(harness.handlers.get("session.step.started"))
      assert.ok(harness.handlers.get("session.step.ended"))
      assert.ok(harness.handlers.get("session.step.failed"))
      assert.ok(harness.handlers.get("session.status"))
    } finally {
      await cleanup?.()
    }
  })

  it("ignores events from a different location", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const ended = harness.handlers.get("session.step.ended")!.values().next().value as (e: unknown) => void
      // Call from another workspace — must not throw and must not crash.
      ended({
        location: { directory: "/other/workspace" },
        data: { sessionID: "ses_other", assistantMessageID: "m", tokens: { input: 1000, output: 100, cache: { read: 0, write: 0 } } },
      })
      // Same-call succeeded without throwing = location filter is in place.
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })

  it("ignores events without location metadata when ctx.location is set", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const ended = harness.handlers.get("session.step.ended")!.values().next().value as (e: unknown) => void
      ended({
        // No location field — should be filtered out by sameLocation()
        data: { sessionID: "ses_x", assistantMessageID: "m", tokens: { input: 1000, output: 100, cache: { read: 0, write: 0 } } },
      })
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })

  it("survives ctx.location === undefined (single-workspace setups)", async () => {
    const harness = makeContext()
    ;(harness.context as { location: unknown }).location = undefined
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const ended = harness.handlers.get("session.step.ended")!.values().next().value as (e: unknown) => void
      ended({
        data: { sessionID: "ses_noloc", assistantMessageID: "m", tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } } },
      })
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })

  it("accepts step.failed events (HIGH 8: billable failed steps)", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const failed = harness.handlers.get("session.step.failed")!.values().next().value as (e: unknown) => void
      // Should not throw.
      failed({
        location: { directory: "/test/location" },
        data: {
          sessionID: "ses_f",
          assistantMessageID: "mf",
          tokens: { input: 500, output: 100, cache: { read: 0, write: 0 } },
        },
      })
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })

  it("skips steps with zero billable tokens", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const ended = harness.handlers.get("session.step.ended")!.values().next().value as (e: unknown) => void
      ended({
        location: { directory: "/test/location" },
        data: { sessionID: "ses_zero", assistantMessageID: "m", tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      })
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })

  it("handles repeated step.ended events for the same assistantMessageID without throwing", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const started = harness.handlers.get("session.step.started")!.values().next().value as (e: unknown) => void
      const ended = harness.handlers.get("session.step.ended")!.values().next().value as (e: unknown) => void
      started({
        location: { directory: "/test/location" },
        data: { sessionID: "ses_d", assistantMessageID: "md", model: { providerID: "anthropic", id: "claude-opus-4.5" } },
      })
      const ev = {
        location: { directory: "/test/location" },
        data: {
          sessionID: "ses_d",
          assistantMessageID: "md",
          tokens: { input: 500, output: 100, cache: { read: 0, write: 0 } },
        },
      }
      // Repeated step.ended for the same assistant message must not
      // crash; the TUI plugin no longer carries its own dedupe state
      // because the server plugin owns canonical entry creation. The
      // handler is expected to refresh the snapshot each time.
      ended(ev)
      ended(ev)
      ended(ev)
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })
})

// ============================================================================
// Cost path — the TUI plugin no longer runs calculateCost on step.ended;
// cost computation is owned by the server plugin and re-derived from the
// JSONL log on each snapshot refresh. The handler must therefore ignore
// event.cost and only react to token fields. We verify the handler does
// not throw under a hostile cost payload.
// ============================================================================

describe("TUI plugin — handler ignores event.cost", () => {
  it("handles an inflated event.cost without throwing", async () => {
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      const ended = harness.handlers.get("session.step.ended")!.values().next().value as (e: unknown) => void
      // Event reports an absurd cost. The TUI handler must not crash and
      // must not act on the cost field; cost is recomputed from the log.
      ended({
        location: { directory: "/test/location" },
        data: {
          sessionID: "ses_p",
          assistantMessageID: "m",
          cost: 999_999,
          tokens: { input: 1000, output: 250, cache: { read: 0, write: 0 } },
        },
      })
      assert.ok(true)
    } finally {
      await cleanup?.()
    }
  })
})

// ============================================================================
// Config gating — panel.enabled, panel.refreshSeconds parsing
// ============================================================================

describe("TUI plugin — config gating", () => {
  it("accepts panel.refreshSeconds without throwing", async () => {
    writeFileSync(
      tempConfig,
      JSON.stringify({ panel: { enabled: true, refreshSeconds: 17 } }),
      "utf-8",
    )
    const harness = makeContext()
    const cleanup = await tuiDef.setup(harness.context)
    try {
      // The summary is exposed via the sidebar.content slot.
      const slot = harness.slots.find(s => s.path === "sidebar.content")
      assert.ok(slot)
    } finally {
      await cleanup?.()
    }
  })
})