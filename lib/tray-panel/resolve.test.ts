import {
  actionForChord,
  chordFromEvent,
  defaultFocusForEffect,
  describeEffect,
  isTriggerLegal,
  openTriggeredActions,
  resolveAction,
  resolvePrimaryAction,
  validateActionDraft,
  visibleActions,
} from "./resolve"
import type { TrayPanelAction } from "./types"
import { defaultSnapshot } from "@/lib/tray/sync"

const snapshot = () => defaultSnapshot()

function action(patch: Partial<TrayPanelAction> = {}): TrayPanelAction {
  return {
    id: "a",
    label: "A",
    fields: [],
    trigger: { kind: "manual" },
    effect: { kind: "navigate", path: "/x" },
    ...patch,
  }
}

describe("resolveAction", () => {
  it("resolves a delegate effect with placeholders driven by its own fields", () => {
    const a = action({
      fields: [
        { kind: "textarea", id: "prompt", label: "P", required: true },
        {
          kind: "select",
          id: "target",
          label: "T",
          options: [
            { value: "newSession", label: "N" },
            { value: "activeSession", label: "A" },
          ],
        },
        { kind: "switch", id: "send", label: "S" },
      ],
      effect: {
        kind: "delegate",
        prompt: "{{prompt}}",
        target: "{{target}}",
        autoSend: "{{send}}",
      },
    })
    const result = resolveAction(
      a,
      { prompt: "Ship it", target: "activeSession", send: true },
      "req-1"
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.effect).toEqual({
      kind: "delegate",
      prompt: "Ship it",
      target: "activeSession",
      autoSend: true,
    })
    expect(result.request.requestId).toBe("req-1")
    expect(result.request.focusMainWindow).toBe(true)
  })

  it("rejects a required field left empty", () => {
    const a = action({
      fields: [{ kind: "text", id: "q", label: "Q", required: true }],
      effect: { kind: "slash", command: "ask {{q}}" },
    })
    const result = resolveAction(a, { q: "   " }, "r")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({ kind: "required", fieldId: "q" })
  })

  it("rejects a target that isn't one of the two destinations", () => {
    // A prompt landing in the wrong conversation is worse than a visible error.
    const a = action({
      fields: [{ kind: "text", id: "t", label: "T" }],
      effect: { kind: "delegate", prompt: "hi", target: "{{t}}", autoSend: false },
    })
    const result = resolveAction(a, { t: "somewhereElse" }, "r")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({ kind: "badTarget", value: "somewhereElse" })
  })

  it("rejects a delegate whose prompt resolves to nothing", () => {
    const a = action({
      fields: [{ kind: "text", id: "p", label: "P" }],
      effect: { kind: "delegate", prompt: "{{p}}", target: "newSession", autoSend: true },
    })
    const result = resolveAction(a, { p: "" }, "r")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({ kind: "emptyEffect" })
  })

  it("normalises a slash command's leading slash exactly once", () => {
    const withSlash = resolveAction(
      action({ effect: { kind: "slash", command: "/clear" } }),
      {},
      "r"
    )
    const without = resolveAction(action({ effect: { kind: "slash", command: "clear" } }), {}, "r")
    expect(withSlash.ok && withSlash.request.effect).toEqual({ kind: "slash", line: "/clear" })
    expect(without.ok && without.request.effect).toEqual({ kind: "slash", line: "/clear" })
  })

  it("normalises a navigate path's leading slash", () => {
    const result = resolveAction(
      action({ effect: { kind: "navigate", path: "scheduler" } }),
      {},
      "r"
    )
    expect(result.ok && result.request.effect).toEqual({ kind: "navigate", path: "/scheduler" })
  })

  it("passes a native action straight through without interpolation", () => {
    const result = resolveAction(action({ effect: { kind: "native", action: "show" } }), {}, "r")
    expect(result.ok && result.request.effect).toEqual({ kind: "native", action: "show" })
    // Natives are handled in Rust and already raise the window themselves.
    expect(result.ok && result.request.focusMainWindow).toBe(false)
  })

  it("reports a placeholder that names no declared field", () => {
    const a = action({ effect: { kind: "slash", command: "run {{nope}}" } })
    const result = resolveAction(a, {}, "r")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({ kind: "unknownPlaceholder", ids: ["nope"] })
  })

  it("honours an explicit focusMainWindow override", () => {
    const a = action({ effect: { kind: "command", commandId: "x.y" }, focusMainWindow: true })
    const result = resolveAction(a, {}, "r")
    expect(result.ok && result.request.focusMainWindow).toBe(true)
  })

  it("uses the supplied label so the main window can name the action in a toast", () => {
    const result = resolveAction(action(), {}, "r", "Translated")
    expect(result.ok && result.request.actionLabel).toBe("Translated")
  })

  it("rejects a delegate that would fire on every panel open", () => {
    const a = action({
      trigger: { kind: "open" },
      effect: { kind: "delegate", prompt: "go", target: "newSession", autoSend: true },
    })
    const result = resolveAction(a, {}, "r")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({ kind: "illegalTrigger" })
  })
})

describe("isTriggerLegal / defaultFocusForEffect", () => {
  it("only allows read-only effects to run on panel open", () => {
    expect(isTriggerLegal(action({ trigger: { kind: "open" } }))).toBe(true)
    expect(
      isTriggerLegal(
        action({ trigger: { kind: "open" }, effect: { kind: "command", commandId: "x" } })
      )
    ).toBe(true)
    expect(
      isTriggerLegal(
        action({ trigger: { kind: "open" }, effect: { kind: "slash", command: "clear" } })
      )
    ).toBe(false)
  })

  it("leaves every other trigger unrestricted", () => {
    expect(isTriggerLegal(action({ trigger: { kind: "submit" } }))).toBe(true)
    expect(isTriggerLegal(action({ trigger: { kind: "hotkey", chord: "mod+1" } }))).toBe(true)
  })

  it("raises the window for user-visible effects only", () => {
    expect(defaultFocusForEffect("delegate")).toBe(true)
    expect(defaultFocusForEffect("navigate")).toBe(true)
    expect(defaultFocusForEffect("slash")).toBe(true)
    expect(defaultFocusForEffect("command")).toBe(false)
    expect(defaultFocusForEffect("native")).toBe(false)
  })
})

describe("validateActionDraft", () => {
  it("accepts a well-formed action", () => {
    expect(
      validateActionDraft(
        action({
          fields: [{ kind: "text", id: "p", label: "P" }],
          effect: { kind: "delegate", prompt: "{{p}}", target: "newSession", autoSend: true },
        })
      )
    ).toEqual([])
  })

  it("flags a missing label", () => {
    expect(validateActionDraft(action({ label: "  " }))).toContainEqual({ kind: "missingLabel" })
  })

  it("accepts a built-in whose label is an i18n key", () => {
    expect(
      validateActionDraft(action({ label: "", labelKey: "trayPanel.actions.openApp.label" }))
    ).not.toContainEqual({ kind: "missingLabel" })
  })

  it("flags duplicate and unusable field ids", () => {
    const issues = validateActionDraft(
      action({
        fields: [
          { kind: "text", id: "a", label: "A" },
          { kind: "text", id: "a", label: "A2" },
          { kind: "text", id: "has space", label: "B" },
        ],
      })
    )
    expect(issues).toContainEqual({ kind: "duplicateFieldId", fieldId: "a" })
    expect(issues).toContainEqual({ kind: "invalidFieldId", fieldId: "has space" })
  })

  it("flags a dropdown with no options", () => {
    const issues = validateActionDraft(
      action({ fields: [{ kind: "select", id: "s", label: "S", options: [] }] })
    )
    expect(issues).toContainEqual({ kind: "emptySelect", fieldId: "s" })
  })

  it("flags a placeholder no field can satisfy", () => {
    const issues = validateActionDraft(action({ effect: { kind: "navigate", path: "/{{gone}}" } }))
    expect(issues).toContainEqual({ kind: "unknownPlaceholder", ids: ["gone"] })
  })

  it("flags an effect with nothing in it, but not a native one", () => {
    expect(validateActionDraft(action({ effect: { kind: "slash", command: "" } }))).toContainEqual({
      kind: "emptyEffect",
    })
    expect(
      validateActionDraft(action({ effect: { kind: "native", action: "quit" } }))
    ).not.toContainEqual({ kind: "emptyEffect" })
  })

  it("flags a hotkey trigger with no chord", () => {
    expect(
      validateActionDraft(action({ trigger: { kind: "hotkey", chord: "  " } }))
    ).toContainEqual({ kind: "missingChord" })
  })

  it("checks placeholders in a delegate's target and autoSend, not just its prompt", () => {
    const issues = validateActionDraft(
      action({
        effect: { kind: "delegate", prompt: "hi", target: "{{t}}", autoSend: "{{s}}" },
      })
    )
    expect(issues).toContainEqual({ kind: "unknownPlaceholder", ids: ["t", "s"] })
  })
})

describe("selection helpers", () => {
  const list: TrayPanelAction[] = [
    action({ id: "hidden", hidden: true }),
    action({ id: "gated", when: "automation.running" }),
    action({ id: "primary", trigger: { kind: "submit" } }),
    action({ id: "second-primary", trigger: { kind: "submit" } }),
    action({ id: "hot", trigger: { kind: "hotkey", chord: "Mod+1" } }),
    action({ id: "onopen", trigger: { kind: "open" } }),
  ]

  it("drops hidden and when-gated actions", () => {
    const ids = visibleActions(list, snapshot()).map((a) => a.id)
    expect(ids).not.toContain("hidden")
    expect(ids).not.toContain("gated")
  })

  it("keeps a when-gated action once its predicate holds", () => {
    const snap = { ...snapshot(), automation: { running: true, armed: true } }
    expect(visibleActions(list, snap).map((a) => a.id)).toContain("gated")
  })

  it("picks the first visible submit action as primary", () => {
    expect(resolvePrimaryAction(list, snapshot())?.id).toBe("primary")
  })

  it("returns null when every submit action is hidden", () => {
    const onlyHidden = [action({ id: "p", trigger: { kind: "submit" }, hidden: true })]
    expect(resolvePrimaryAction(onlyHidden, snapshot())).toBeNull()
  })

  it("returns only legal open-triggered actions", () => {
    const withIllegal = [
      ...list,
      action({
        id: "illegal",
        trigger: { kind: "open" },
        effect: { kind: "delegate", prompt: "x", target: "newSession", autoSend: true },
      }),
    ]
    expect(openTriggeredActions(withIllegal, snapshot()).map((a) => a.id)).toEqual(["onopen"])
  })

  it("matches a hotkey case-insensitively", () => {
    expect(actionForChord(list, snapshot(), "mod+1")?.id).toBe("hot")
    expect(actionForChord(list, snapshot(), "mod+2")).toBeNull()
  })
})

describe("chordFromEvent", () => {
  const base = { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }

  it("folds meta and ctrl into one `mod` token", () => {
    expect(chordFromEvent({ ...base, metaKey: true })).toBe("mod+k")
    expect(chordFromEvent({ ...base, ctrlKey: true })).toBe("mod+k")
  })

  it("emits modifiers in a fixed order and lowercases the key", () => {
    expect(
      chordFromEvent({ key: "K", metaKey: true, ctrlKey: false, altKey: true, shiftKey: true })
    ).toBe("mod+alt+shift+k")
  })

  it("handles a bare key", () => {
    expect(chordFromEvent({ ...base, key: "Escape" })).toBe("escape")
  })
})

describe("describeEffect", () => {
  it("summarises each effect kind for the settings list", () => {
    expect(
      describeEffect({ kind: "delegate", prompt: "go", target: "newSession", autoSend: true })
    ).toBe("go")
    expect(describeEffect({ kind: "slash", command: "clear" })).toBe("/clear")
    expect(describeEffect({ kind: "slash", command: "/clear" })).toBe("/clear")
    expect(describeEffect({ kind: "command", commandId: "a.b" })).toBe("a.b")
    expect(describeEffect({ kind: "native", action: "show" })).toBe("show")
    expect(describeEffect({ kind: "navigate", path: "/x" })).toBe("/x")
  })
})
