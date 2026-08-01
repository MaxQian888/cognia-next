import {
  canRedoDockLayout,
  canUndoDockLayout,
  commitDockTransaction,
  DOCK_HISTORY_LIMIT,
  EMPTY_DOCK_HISTORY,
  redoDockLayout,
  undoDockLayout,
  type DockHistoryState,
} from "./transaction"
import {
  DEFAULT_DOCK_SHELL_STATE,
  DOCK_LAYOUT_SCHEMA_VERSION,
  type DockLayoutEnvelope,
} from "@/types/dock/layout"

function envelope(overrides: Partial<DockLayoutEnvelope> = {}): DockLayoutEnvelope {
  return {
    schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION,
    key: { accountId: "acc", host: "chat", contextId: "session-1" },
    grid: null,
    instances: [],
    shell: DEFAULT_DOCK_SHELL_STATE,
    revision: 1,
    updatedAt: 100,
    ...overrides,
  }
}

const setSize = (sizePercent: number) => (current: DockLayoutEnvelope) => ({
  ...current,
  shell: { ...current.shell, sizePercent },
})

describe("commitDockTransaction", () => {
  it("bumps the revision and stamps the time on a successful commit", () => {
    const out = commitDockTransaction(
      envelope(),
      EMPTY_DOCK_HISTORY,
      { baseRevision: 1, label: "shell.resize", apply: setSize(50) },
      500
    )
    expect(out.result.ok).toBe(true)
    expect(out.result.envelope.revision).toBe(2)
    expect(out.result.envelope.updatedAt).toBe(500)
    expect(out.result.envelope.shell.sizePercent).toBe(50)
  })

  it("rejects a write computed against a stale revision without mutating", () => {
    // The reason dockview is an emitter and not a writer: a mid-drag emission
    // carrying an older revision must not overwrite a committed change.
    const current = envelope({ revision: 7 })
    const out = commitDockTransaction(
      current,
      EMPTY_DOCK_HISTORY,
      { baseRevision: 5, label: "shell.resize", apply: setSize(50) },
      500
    )
    expect(out.result).toEqual({ ok: false, rejection: "stale-revision", envelope: current })
    expect(out.history).toBe(EMPTY_DOCK_HISTORY)
  })

  it("rejects a transaction that rewrites the layout key", () => {
    const current = envelope()
    const out = commitDockTransaction(
      current,
      EMPTY_DOCK_HISTORY,
      {
        baseRevision: 1,
        label: "bad",
        apply: (e) => ({ ...e, key: { ...e.key, contextId: "other" } }),
      },
      500
    )
    expect(out.result).toEqual({ ok: false, rejection: "key-mismatch", envelope: current })
  })

  it("records only structural changes in history", () => {
    const first = commitDockTransaction(
      envelope(),
      EMPTY_DOCK_HISTORY,
      { baseRevision: 1, label: "shell.resize", apply: setSize(40) },
      500
    )
    expect(first.history.past).toHaveLength(0)

    const second = commitDockTransaction(
      first.result.envelope,
      first.history,
      { baseRevision: 2, label: "panel.split", apply: setSize(60), structural: true },
      600
    )
    expect(second.history.past).toHaveLength(1)
  })

  it("drops the redo branch when a new structural change lands", () => {
    const base = envelope()
    const history: DockHistoryState = { past: [base], future: [envelope({ revision: 99 })] }
    const out = commitDockTransaction(
      envelope({ revision: 2 }),
      history,
      { baseRevision: 2, label: "panel.move", apply: setSize(30), structural: true },
      700
    )
    expect(out.history.future).toEqual([])
    expect(out.history.past).toHaveLength(2)
  })

  it("bounds the undo stack", () => {
    let current = envelope()
    let history = EMPTY_DOCK_HISTORY
    for (let i = 0; i < DOCK_HISTORY_LIMIT + 10; i += 1) {
      const out = commitDockTransaction(
        current,
        history,
        {
          baseRevision: current.revision,
          label: "panel.move",
          apply: setSize(20 + (i % 30)),
          structural: true,
        },
        1000 + i
      )
      current = out.result.envelope
      history = out.history
    }
    expect(history.past).toHaveLength(DOCK_HISTORY_LIMIT)
  })
})

describe("undo / redo", () => {
  it("returns null when there is nothing to step to", () => {
    expect(undoDockLayout(envelope(), EMPTY_DOCK_HISTORY, 1)).toBeNull()
    expect(redoDockLayout(envelope(), EMPTY_DOCK_HISTORY, 1)).toBeNull()
    expect(canUndoDockLayout(EMPTY_DOCK_HISTORY)).toBe(false)
    expect(canRedoDockLayout(EMPTY_DOCK_HISTORY)).toBe(false)
  })

  it("restores the previous layout while moving the revision forward", () => {
    // Revisions order writes; they are not a version number. Rewinding one
    // would let a write computed before the undo land after it.
    const before = envelope({
      revision: 1,
      shell: { ...DEFAULT_DOCK_SHELL_STATE, sizePercent: 20 },
    })
    const current = envelope({
      revision: 2,
      shell: { ...DEFAULT_DOCK_SHELL_STATE, sizePercent: 60 },
    })
    const step = undoDockLayout(current, { past: [before], future: [] }, 900)!

    expect(step.envelope.shell.sizePercent).toBe(20)
    expect(step.envelope.revision).toBe(3)
    expect(step.envelope.updatedAt).toBe(900)
    expect(step.history).toEqual({ past: [], future: [current] })
    expect(canRedoDockLayout(step.history)).toBe(true)
  })

  it("round-trips undo then redo back to the same layout", () => {
    const before = envelope({
      revision: 1,
      shell: { ...DEFAULT_DOCK_SHELL_STATE, sizePercent: 20 },
    })
    const current = envelope({
      revision: 2,
      shell: { ...DEFAULT_DOCK_SHELL_STATE, sizePercent: 60 },
    })

    const undone = undoDockLayout(current, { past: [before], future: [] }, 900)!
    const redone = redoDockLayout(undone.envelope, undone.history, 950)!

    expect(redone.envelope.shell.sizePercent).toBe(60)
    expect(redone.envelope.revision).toBe(4)
    expect(redone.history.future).toEqual([])
    expect(redone.history.past).toHaveLength(1)
  })

  it("bounds the undo stack on redo too", () => {
    const past = Array.from({ length: DOCK_HISTORY_LIMIT }, (_, i) => envelope({ revision: i + 1 }))
    const step = redoDockLayout(envelope({ revision: 99 }), { past, future: [envelope()] }, 1)!
    expect(step.history.past).toHaveLength(DOCK_HISTORY_LIMIT)
  })
})
