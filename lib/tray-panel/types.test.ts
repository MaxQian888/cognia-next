// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage; the literals below pin the authored
// shapes (`TrayPanelAction`) against the resolved cross-window ones
// (`TrayPanelRunRequest`), which is the split the whole subsystem hangs on.
import "./types"
import type {
  TrayPanelAction,
  TrayPanelConfig,
  TrayPanelEffect,
  TrayPanelEffectKind,
  TrayPanelField,
  TrayPanelFieldKind,
  TrayPanelFieldRef,
  TrayPanelResolvedEffect,
  TrayPanelRunRequest,
  TrayPanelRunResult,
  TrayPanelTrigger,
  TrayPanelTriggerKind,
  TrayPanelValues,
  TrayLeftClickAction,
} from "./types"

describe("fields", () => {
  it("covers the five input kinds the panel renders", () => {
    const kinds: TrayPanelFieldKind[] = ["text", "textarea", "select", "switch", "number"]
    expect(new Set(kinds).size).toBe(5)
  })

  it("lets a textarea claim Enter — the delegate composer's whole point", () => {
    const field: TrayPanelField = {
      kind: "textarea",
      id: "prompt",
      label: "Prompt",
      required: true,
      submitOnEnter: true,
      rows: 3,
    }
    expect(field.kind === "textarea" && field.submitOnEnter).toBe(true)
  })

  it("holds switch values as booleans and the rest as strings or numbers", () => {
    const values: TrayPanelValues = { prompt: "hi", autoSend: true, count: 2 }
    expect(typeof values.autoSend).toBe("boolean")
    expect(typeof values.prompt).toBe("string")
    expect(typeof values.count).toBe("number")
  })
})

describe("effects", () => {
  it("covers the five effect kinds", () => {
    const kinds: TrayPanelEffectKind[] = ["delegate", "slash", "command", "native", "navigate"]
    expect(new Set(kinds).size).toBe(5)
  })

  it("lets a field drive a non-string member through a whole-value ref", () => {
    const ref: TrayPanelFieldRef = "{{target}}"
    const effect: TrayPanelEffect = {
      kind: "delegate",
      prompt: "Summarise {{selection}}",
      target: ref,
      autoSend: "{{send}}",
    }
    expect(effect.kind === "delegate" && effect.target).toBe("{{target}}")
  })

  it("resolves every placeholder before the effect crosses windows", () => {
    // The authored `delegate` widens target/autoSend to a field ref; the
    // resolved twin does not — that narrowing IS the resolution step.
    const resolved: TrayPanelResolvedEffect = {
      kind: "delegate",
      prompt: "Summarise the page",
      target: "newSession",
      autoSend: true,
    }
    expect(resolved.kind === "delegate" && resolved.target).toBe("newSession")
  })

  it("flattens a slash effect from an authored `command` to a resolved `line`", () => {
    const authored: TrayPanelEffect = { kind: "slash", command: "/goal {{name}}" }
    const resolved: TrayPanelResolvedEffect = { kind: "slash", line: "/goal ship it" }
    expect(authored.kind === "slash" && authored.command).toContain("{{name}}")
    expect(resolved.kind === "slash" && resolved.line).not.toContain("{{")
  })
})

describe("triggers", () => {
  it("covers the four ways an action fires", () => {
    const kinds: TrayPanelTriggerKind[] = ["manual", "submit", "open", "hotkey"]
    expect(new Set(kinds).size).toBe(4)
  })

  it("carries the chord only on the hotkey arm", () => {
    const hotkey: TrayPanelTrigger = { kind: "hotkey", chord: "mod+1" }
    const manual: TrayPanelTrigger = { kind: "manual" }
    expect(hotkey.kind === "hotkey" && hotkey.chord).toBe("mod+1")
    expect(Object.keys(manual)).toEqual(["kind"])
  })
})

describe("TrayPanelAction", () => {
  it("defaults every optional knob — a minimal action is id/label/fields/effect/trigger", () => {
    const action: TrayPanelAction = {
      id: "trayPanel.delegate",
      label: "Delegate",
      fields: [],
      effect: { kind: "navigate", path: "/" },
      trigger: { kind: "manual" },
    }
    expect(action.when).toBeUndefined()
    expect(action.focusMainWindow).toBeUndefined()
    expect(action.hidden).toBeUndefined()
    expect(action.builtIn).toBeUndefined()
  })

  it("marks a built-in so reset() can restore it — hidden, but never deleted", () => {
    const action: TrayPanelAction = {
      id: "trayPanel.delegate",
      label: "Delegate",
      labelKey: "delegate",
      icon: "Send",
      fields: [],
      effect: { kind: "navigate", path: "/" },
      trigger: { kind: "submit" },
      builtIn: true,
      hidden: true,
    }
    expect(action.builtIn).toBe(true)
    expect(action.hidden).toBe(true)
  })
})

describe("cross-window request/result", () => {
  it("correlates the result back to the panel's pending state by requestId", () => {
    const request: TrayPanelRunRequest = {
      requestId: "req_1",
      actionId: "trayPanel.delegate",
      actionLabel: "Delegate",
      effect: { kind: "command", commandId: "cognia.newChat" },
      focusMainWindow: true,
    }
    const result: TrayPanelRunResult = { requestId: "req_1", ok: false, error: "已翻译的错误" }
    expect(result.requestId).toBe(request.requestId)
    expect(result.error).toBeDefined()
  })

  it("omits `error` on success", () => {
    const result: TrayPanelRunResult = { requestId: "req_1", ok: true }
    expect(result.error).toBeUndefined()
  })
})

describe("TrayPanelConfig", () => {
  it("enumerates the three left-click behaviours Rust honours", () => {
    const actions: TrayLeftClickAction[] = ["panel", "toggle-window", "none"]
    expect(new Set(actions).size).toBe(3)
  })

  it("requires all three fields — Rust owns the file and always writes them", () => {
    const config: TrayPanelConfig = { leftClick: "panel", width: 360, height: 480 }
    expect(Object.keys(config).sort()).toEqual(["height", "leftClick", "width"])
  })
})
