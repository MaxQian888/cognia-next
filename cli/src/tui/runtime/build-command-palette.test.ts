import type { BackendCapabilities } from "./backend-capabilities"
import { registerFeatureCommands, __resetFeatureRegistrationForTesting } from "../commands/index"
/**
 * @jest-environment node
 */
import { buildCommandPalette } from "./build-command-palette"
import { __resetForTesting } from "../commands/registry"
import type { ResolvedConfig } from "../../config/schema"

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    provider: "anthropic",
    providers: {},
    permissionMode: "default",
    cwd: "/repo",
    ...over,
  } as ResolvedConfig
}

beforeEach(() => {
  __resetForTesting()
  __resetFeatureRegistrationForTesting()
  registerFeatureCommands()
})

describe("buildCommandPalette", () => {
  it("keeps quota inspection reachable when the external protocol exposes no quota API", () => {
    const rows = buildCommandPalette(config({ agentBackend: "gemini-cli" }), {
      backendCapabilities: {
        backend: "gemini-cli",
        builtin: false,
        features: { rateLimits: { supported: false } },
      } as BackendCapabilities,
    })
    const limits = rows.find((row) => row.command === "/limits")
    expect(limits).toBeDefined()
    expect(limits?.disabledReason).toBeUndefined()
  })
  it("leads with the curated quick actions carrying live hints", () => {
    const rows = buildCommandPalette(config({ permissionMode: "plan" }))
    expect(rows[0]?.id).toBe("mode")
    expect(rows.find((r) => r.id === "mode")?.hint).toBe("plan")
  })

  it("appends visible registry commands not already curated", () => {
    const rows = buildCommandPalette(config())
    // `/sessions` is a core command with no curated row → it is appended.
    expect(rows.some((r) => r.command === "/sessions")).toBe(true)
  })

  it("does not duplicate a command already fronted by a curated row", () => {
    const rows = buildCommandPalette(config())
    expect(rows.filter((r) => r.command === "/model")).toHaveLength(1)
  })

  it("gives every row an id, label and slash command", () => {
    for (const r of buildCommandPalette(config())) {
      expect(r.id).toBeTruthy()
      expect(r.label).toBeTruthy()
      expect(r.command.startsWith("/")).toBe(true)
    }
  })
})

it("keeps unavailable commands searchable with a recovery reason", () => {
  const rows = buildCommandPalette(config(), {
    backendCapabilities: {
      backend: "test",
      builtin: false,
      features: { compact: { supported: false, reason: "no compaction channel" } },
    } as BackendCapabilities,
  })
  expect(rows.find((r) => r.command === "/compact")?.disabledReason).toContain("/backend")
})
it("prioritizes the running task without removing the catalog", () => {
  const rows = buildCommandPalette(config(), {
    activity: { kind: "goal", label: "work", status: "running" },
  })
  expect(rows[0]?.command).toBe("/goal status")
  expect(rows.some((r) => r.command === "/sessions")).toBe(true)
})

it("disables backend-owned provider settings and busy mutations", () => {
  const external = buildCommandPalette(config({ agentBackend: "codex" }), {
    backendCapabilities: { backend: "test", builtin: false, features: {} } as BackendCapabilities,
  })
  expect(external.find((r) => r.command === "/provider")?.disabledReason).toContain("built-in")
  const busy = buildCommandPalette(config(), { turnStatus: "streaming" })
  expect(busy.find((r) => r.command === "/clear")?.disabledReason).toContain("Esc")
  expect(busy.find((r) => r.command === "/help")?.disabledReason).toBeUndefined()
})
it("uses a safe status action for loops and prioritizes an existing plan", () => {
  const rows = buildCommandPalette(config(), {
    activity: { kind: "loop", label: "work", status: "running" },
    lastPlan: { raw: "plan", seq: 1 },
  })
  expect(rows[0]?.command).toBe("/status")
  expect(rows[1]?.command).toBe("/plan")
  expect(
    buildCommandPalette(config(), { activity: { kind: "agent", label: "work", status: "done" } })[0]
      .id
  ).toBe("mode")
})
it("renders Chinese curated actions and a fallback capability reason", () => {
  const rows = buildCommandPalette(config({ locale: "zh-CN" }), {
    backendCapabilities: {
      backend: "test",
      builtin: false,
      features: { compact: { supported: false } },
    } as BackendCapabilities,
  })
  expect(rows.find((r) => r.id === "help")?.label).toBe("帮助")
  expect(rows.find((r) => r.command === "/compact")?.disabledReason).toContain("当前后端不支持")
})
