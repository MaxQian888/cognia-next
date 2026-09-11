import type { BackendCapabilities } from "../runtime/backend-capabilities"
import { __resetForTesting } from "./registry"
import { registerFeatureCommands, __resetFeatureRegistrationForTesting } from "./index"
import { menuCommand } from "./menu-command"
import type { CommandContext } from "./types"
import type { ResolvedConfig } from "../../config/schema"

function ctx(over: Partial<ResolvedConfig> = {}): CommandContext {
  return {
    state: {} as CommandContext["state"],
    config: {
      provider: "anthropic",
      providers: {},
      permissionMode: "default",
      cwd: "/repo",
      ...over,
    } as ResolvedConfig,
    version: "test",
    args: "",
  }
}

describe("menuCommand", () => {
  it("is registered under /menu with launcher aliases", () => {
    expect(menuCommand.name).toBe("menu")
    expect(menuCommand.aliases).toEqual(expect.arrayContaining(["actions", "quick"]))
  })

  it("opens the quickActions overlay populated from the live config", () => {
    const effect = menuCommand.handler!(ctx({ permissionMode: "plan" }))
    if (effect.kind !== "openOverlay" || effect.overlay.kind !== "quickActions") {
      throw new Error(`expected quickActions overlay, got ${effect.kind}`)
    }
    expect(effect.overlay.rows.length).toBeGreaterThan(0)
    expect(effect.overlay.rows.find((r) => r.id === "mode")?.hint).toBe("plan")
  })
})

it("forwards live backend capabilities into palette availability", () => {
  const context = ctx()
  context.state.backendCapabilities = {
    backend: "test",
    builtin: false,
    features: { compact: { supported: false } },
  } as BackendCapabilities
  const effect = menuCommand.handler!(context)
  if (effect.kind !== "openOverlay" || effect.overlay.kind !== "quickActions")
    throw new Error("missing palette")
  expect(effect.overlay.rows.find((r) => r.command === "/compact")?.disabledReason).toContain(
    "/backend"
  )
})

beforeEach(() => {
  __resetForTesting()
  __resetFeatureRegistrationForTesting()
  registerFeatureCommands()
})
