import { DIAGNOSTIC_ACTION_KINDS, DIAGNOSTIC_CODES, DIAGNOSTIC_CODE_IDS } from "@cognia/diagnostics"
import type { DiagnosticAction } from "@cognia/diagnostics"

import {
  DIAGNOSTIC_ACTION_SPECS,
  diagnosticActionCommand,
  isGlobalAction,
  toNotificationActions,
} from "./actions"

const labelFor = (kind: string) => `label:${kind}`

describe("DIAGNOSTIC_ACTION_SPECS", () => {
  it("covers every action kind", () => {
    expect(Object.keys(DIAGNOSTIC_ACTION_SPECS).sort()).toEqual([...DIAGNOSTIC_ACTION_KINDS].sort())
  })

  it("derives the label key from the shared i18n contract", () => {
    expect(DIAGNOSTIC_ACTION_SPECS["wait-and-retry"].labelKey).toBe("waitAndRetry")
    expect(DIAGNOSTIC_ACTION_SPECS.retry.labelKey).toBe("retry")
  })

  it("keeps re-run actions host-scoped", () => {
    // Only the surface that produced the failure still holds the closure that
    // can re-issue it; a persisted Retry button would be a lie.
    for (const kind of [
      "retry",
      "wait-and-retry",
      "retry-fallback-provider",
      "retry-when-online",
      "switch-to-builtin",
      "reset-boundary",
    ] as const) {
      expect(DIAGNOSTIC_ACTION_SPECS[kind].availability).toBe("host")
    }
  })

  it("keeps navigation and reporting actions global", () => {
    for (const kind of [
      "open-settings",
      "view-logs",
      "reload-app",
      "export-crash-log",
      "copy-report",
      "report-issue",
      "dismiss",
    ] as const) {
      expect(DIAGNOSTIC_ACTION_SPECS[kind].availability).toBe("global")
    }
  })
})

describe("diagnosticActionCommand", () => {
  it("namespaces the command key", () => {
    expect(diagnosticActionCommand("retry")).toBe("diagnostic.retry")
  })

  it("produces a distinct key per kind", () => {
    const keys = DIAGNOSTIC_ACTION_KINDS.map(diagnosticActionCommand)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("isGlobalAction", () => {
  it("classifies by kind, not by payload", () => {
    expect(isGlobalAction({ kind: "open-settings", section: "providers" })).toBe(true)
    expect(isGlobalAction({ kind: "wait-and-retry", retryAfterMs: 1000 })).toBe(false)
  })
})

describe("toNotificationActions", () => {
  it("carries the payload through as serializable args", () => {
    const actions: DiagnosticAction[] = [
      { kind: "open-settings", section: "providers", focus: "anthropic-key" },
    ]
    expect(toNotificationActions(actions, labelFor)).toEqual([
      {
        id: "open-settings",
        label: "label:open-settings",
        command: "diagnostic.open-settings",
        args: { section: "providers", focus: "anthropic-key" },
      },
    ])
  })

  it("omits args entirely for a payload-free action", () => {
    expect(toNotificationActions([{ kind: "view-logs" }], labelFor)).toEqual([
      { id: "view-logs", label: "label:view-logs", command: "diagnostic.view-logs" },
    ])
  })

  it("drops host-only actions rather than shipping a dead button", () => {
    // `notification-item` renders `action.label` verbatim and dispatches by
    // command; it has no way to express "this can't work right now".
    const actions: DiagnosticAction[] = [
      { kind: "retry" },
      { kind: "open-settings", section: "providers" },
      { kind: "switch-to-builtin" },
    ]
    expect(toNotificationActions(actions, labelFor).map((a) => a.id)).toEqual(["open-settings"])
  })

  it("also drops global kinds the caller reports as having no executor", () => {
    const actions: DiagnosticAction[] = [
      { kind: "reauth", providerId: "anthropic" },
      { kind: "open-settings", section: "providers" },
      { kind: "retry" },
    ]
    const registered = new Set<string>(["open-settings"])
    expect(
      toNotificationActions(actions, labelFor, (kind) => registered.has(kind)).map((a) => a.id)
    ).toEqual(["open-settings"])
  })

  it("returns nothing when every action needs a live surface", () => {
    expect(toNotificationActions([{ kind: "retry" }, { kind: "shorten-input" }], labelFor)).toEqual(
      []
    )
  })

  it("preserves the registry's most-useful-first ordering", () => {
    const actions = DIAGNOSTIC_CODES.prerequisiteMissing.actions
    const projected = toNotificationActions(actions, labelFor).map((a) => a.id)
    const expected = actions.filter(isGlobalAction).map((a) => a.kind)
    expect(projected).toEqual(expected)
  })

  it("leaves something clickable on every diagnostic that can reach the center", () => {
    // A persistent error/fatal is the shape most likely to be delivered to the
    // notification center rather than an on-screen surface — the user wasn't
    // watching when it happened, and the condition is still true. If all of its
    // actions were host-only the row would arrive with nothing to click.
    //
    // Warning/info persistents (`offline`, `transportBlocked`, `documentedOnly`)
    // are deliberately exempt: they are steady states rendered as badges and
    // inert labels, and pushing them into the center would be the noise the
    // surface rules exist to prevent.
    const stranded = DIAGNOSTIC_CODE_IDS.filter((code) => {
      const spec = DIAGNOSTIC_CODES[code]
      const reachesCenter =
        spec.persistent && (spec.severity === "error" || spec.severity === "fatal")
      return reachesCenter && toNotificationActions(spec.actions, labelFor).length === 0
    })
    expect(stranded).toEqual([])
  })
})
