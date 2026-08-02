import {
  BUILT_IN_ACTION_IDS,
  DEFAULT_TRAY_PANEL_ACTIONS,
  DELEGATE_PROMPT_FIELD,
  TRAY_PANEL_ACTIONS_PREF,
  ensureBuiltInActions,
  resolveLabel,
} from "./defaults"
import { resolveAction, resolvePrimaryAction, validateActionDraft } from "./resolve"
import type { TrayPanelAction } from "./types"
import { defaultSnapshot } from "@/lib/tray/sync"

describe("shipped catalogue", () => {
  it("every default action is well-formed", () => {
    // The panel has no room to explain a broken entry — a malformed default
    // would read as a silently inert row.
    for (const action of DEFAULT_TRAY_PANEL_ACTIONS) {
      expect({ id: action.id, issues: validateActionDraft(action) }).toEqual({
        id: action.id,
        issues: [],
      })
    }
  })

  it("marks every default as built-in with a unique id", () => {
    expect(DEFAULT_TRAY_PANEL_ACTIONS.every((a) => a.builtIn)).toBe(true)
    expect(new Set(BUILT_IN_ACTION_IDS).size).toBe(BUILT_IN_ACTION_IDS.length)
  })

  it("ships exactly one submit action, so the panel always has a primary", () => {
    const submits = DEFAULT_TRAY_PANEL_ACTIONS.filter((a) => a.trigger.kind === "submit")
    expect(submits).toHaveLength(1)
    expect(resolvePrimaryAction(DEFAULT_TRAY_PANEL_ACTIONS, defaultSnapshot())?.id).toBe(
      "trayPanel.delegate"
    )
  })

  it("the delegate action runs end-to-end from its own field values", () => {
    const delegate = DEFAULT_TRAY_PANEL_ACTIONS.find((a) => a.id === "trayPanel.delegate")!
    const result = resolveAction(
      delegate,
      { [DELEGATE_PROMPT_FIELD]: "Fix the flaky test", target: "newSession", send: true },
      "r"
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.effect).toEqual({
      kind: "delegate",
      prompt: "Fix the flaky test",
      target: "newSession",
      autoSend: true,
    })
  })

  it("gates the stop-automation action on something actually running", () => {
    const stop = DEFAULT_TRAY_PANEL_ACTIONS.find((a) => a.id === "trayPanel.stopAutomation")!
    expect(stop.when).toBe("automation.running")
  })

  it("uses a versioned pref key", () => {
    expect(TRAY_PANEL_ACTIONS_PREF).toBe("trayPanel.actions.v1")
  })
})

describe("ensureBuiltInActions", () => {
  const custom = (id: string): TrayPanelAction => ({
    id,
    label: id,
    fields: [],
    trigger: { kind: "manual" },
    effect: { kind: "native", action: "show" },
  })

  it("backfills a built-in a stored list predates, at its shipped position", () => {
    const stored = DEFAULT_TRAY_PANEL_ACTIONS.filter((a) => a.id !== "trayPanel.scheduler")
    const result = ensureBuiltInActions(stored)
    const shippedIndex = DEFAULT_TRAY_PANEL_ACTIONS.findIndex((a) => a.id === "trayPanel.scheduler")
    expect(result.map((a) => a.id)).toContain("trayPanel.scheduler")
    expect(result[shippedIndex].id).toBe("trayPanel.scheduler")
  })

  it("keeps a hidden built-in hidden rather than re-adding it", () => {
    const stored = DEFAULT_TRAY_PANEL_ACTIONS.map((a) =>
      a.id === "trayPanel.settings" ? { ...a, hidden: true } : a
    )
    const result = ensureBuiltInActions(stored)
    expect(result.filter((a) => a.id === "trayPanel.settings")).toHaveLength(1)
    expect(result.find((a) => a.id === "trayPanel.settings")?.hidden).toBe(true)
  })

  it("preserves the user's ordering and custom entries", () => {
    const stored = [custom("mine"), ...DEFAULT_TRAY_PANEL_ACTIONS]
    const result = ensureBuiltInActions(stored)
    expect(result[0].id).toBe("mine")
    expect(result).toHaveLength(stored.length)
  })

  it("does not mutate the input array", () => {
    const stored = [custom("mine")]
    const before = stored.slice()
    ensureBuiltInActions(stored)
    expect(stored).toEqual(before)
  })

  it("rebuilds the whole catalogue from an empty list", () => {
    expect(ensureBuiltInActions([]).map((a) => a.id)).toEqual(BUILT_IN_ACTION_IDS)
  })
})

describe("resolveLabel", () => {
  it("prefers the i18n key when present", () => {
    expect(resolveLabel({ label: "raw", labelKey: "some.key" }, () => "Translated")).toBe(
      "Translated"
    )
  })

  it("uses the literal label for user-authored entries", () => {
    expect(resolveLabel({ label: "My action" }, () => "should not be used")).toBe("My action")
  })

  it("falls back to the literal label when the message is missing", () => {
    // next-intl throws on a missing key; a built-in whose message was dropped
    // must still render something clickable.
    expect(
      resolveLabel({ label: "fallback", labelKey: "gone" }, () => {
        throw new Error("MISSING_MESSAGE")
      })
    ).toBe("fallback")
  })
})
