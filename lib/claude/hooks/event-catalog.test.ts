import type { HookEvent } from "@/lib/claude/hooks"
import {
  HOOK_EVENT_CATALOG,
  HOOK_EVENTS,
  HOOK_EVENT_CATEGORIES,
  HOOK_EVENT_META,
  hookEventsByCategory,
  isDormantEvent,
  isKnownHookEvent,
} from "./event-catalog"

// The authoritative list of every HookEvent, kept here independently of the
// catalog so a drift in either direction (a member missing from the catalog,
// or an extra one) fails the test rather than silently passing.
const ALL_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "StopFailure",
  "Notification",
  "PermissionRequest",
  "PermissionDenied",
  "Elicitation",
  "ElicitationResult",
  "TaskCreated",
  "TaskCompleted",
  "SubagentStop",
  "TeammateIdle",
  "PreCompact",
  "PostCompact",
  "WorktreeCreate",
  "WorktreeRemove",
  "FileChanged",
  "CwdChanged",
  "InstructionsLoaded",
  "ConfigChange",
]

// The dormant set as it stood before the catalog folded it in.
const DORMANT_EVENTS: HookEvent[] = [
  "WorktreeCreate",
  "WorktreeRemove",
  "FileChanged",
  "Elicitation",
  "ElicitationResult",
  "UserPromptExpansion",
  "TeammateIdle",
]

describe("HOOK_EVENT_CATALOG", () => {
  it("contains every HookEvent exactly once", () => {
    expect(HOOK_EVENT_CATALOG).toHaveLength(ALL_EVENTS.length)
    const events = HOOK_EVENT_CATALOG.map((m) => m.event)
    expect(new Set(events).size).toBe(events.length)
    expect([...events].sort()).toEqual([...ALL_EVENTS].sort())
  })

  it("derives HOOK_EVENTS in the same order as the catalog", () => {
    expect(HOOK_EVENTS).toEqual(HOOK_EVENT_CATALOG.map((m) => m.event))
  })

  it("assigns every event to a known category", () => {
    for (const meta of HOOK_EVENT_CATALOG) {
      expect(HOOK_EVENT_CATEGORIES).toContain(meta.category)
    }
  })
})

describe("HOOK_EVENT_META", () => {
  it("looks up every event", () => {
    for (const evt of ALL_EVENTS) {
      expect(HOOK_EVENT_META[evt]?.event).toBe(evt)
    }
  })
})

describe("isDormantEvent", () => {
  it("flags exactly the dormant events", () => {
    const dormant = HOOK_EVENT_CATALOG.filter((m) => m.dormant).map((m) => m.event)
    expect([...dormant].sort()).toEqual([...DORMANT_EVENTS].sort())
  })

  it("returns true for a dormant event and false for an active one", () => {
    expect(isDormantEvent("WorktreeCreate")).toBe(true)
    expect(isDormantEvent("PreToolUse")).toBe(false)
  })
})

describe("hookEventsByCategory", () => {
  it("partitions all events across the category buckets", () => {
    const grouped = hookEventsByCategory()
    const total = HOOK_EVENT_CATEGORIES.reduce((sum, cat) => sum + grouped[cat].length, 0)
    expect(total).toBe(ALL_EVENTS.length)
    // tools bucket holds the four tool events.
    expect(grouped.tools.map((m) => m.event)).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PostToolBatch",
      "PostToolUseFailure",
    ])
  })

  it("places each event under its own category", () => {
    const grouped = hookEventsByCategory()
    for (const cat of HOOK_EVENT_CATEGORIES) {
      for (const meta of grouped[cat]) {
        expect(meta.category).toBe(cat)
      }
    }
  })
})

describe("isKnownHookEvent", () => {
  it("is true for any catalog event", () => {
    expect(isKnownHookEvent("PreToolUse")).toBe(true)
    expect(isKnownHookEvent("WorktreeCreate")).toBe(true)
  })

  it("is false for an unrecognised id", () => {
    expect(isKnownHookEvent("SomeFutureEvent")).toBe(false)
    expect(isKnownHookEvent("")).toBe(false)
  })
})
