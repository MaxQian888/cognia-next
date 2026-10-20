import { gatewayModelSlots } from "./model-slots"
import { getPresetConfig } from "./presets"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

const config = (preset: string, protocol = "acp", transport = "stdio") =>
  ({
    id: "saved",
    name: "Agent",
    enabled: true,
    protocol,
    transport,
    process: {
      command:
        getPresetConfig(preset)?.process?.command ??
        (protocol === "opencode-v2" ? "opencode" : "agent"),
      args: getPresetConfig(preset)?.process?.args,
    },
    metadata: { preset },
  }) as ExternalAgentConfig

const ids = (source: ExternalAgentConfig) => gatewayModelSlots(source).map((slot) => slot.id)

describe("gatewayModelSlots", () => {
  it("declares Claude's child default and the three alias tiers", () => {
    expect(ids(config("claude-code"))).toEqual([
      "subagent.default",
      "tier.haiku",
      "tier.sonnet",
      "tier.opus",
    ])
  })

  it("declares Codex's child default with its effort ladder on both transports", () => {
    for (const source of [
      config("codex-app-server", "codex-app-server"),
      config("codex-acp", "acp"),
    ]) {
      const slots = gatewayModelSlots(source)
      expect(slots.map((slot) => slot.id)).toEqual(["subagent.default"])
      expect(slots[0].reasoningEfforts).toEqual(["minimal", "low", "medium", "high", "xhigh"])
      expect(slots[0].evidence).toContain(">= 0.145")
      expect(slots[0].evidence).toContain("[agents]")
      expect(slots[0].evidence).toContain("model_catalog_json")
    }
  })

  it("gives OpenCode V1 a small model but not V2, whose schema has none", () => {
    expect(ids(config("opencode-acp"))).toEqual(["subagent.default", "aux.small"])
    expect(ids(config("opencode-server", "opencode", "sse"))).toEqual([
      "subagent.default",
      "aux.small",
    ])
    expect(ids(config("opencode-v2-service", "opencode-v2", "sse"))).toEqual(["subagent.default"])
  })

  it("leaves gateway runtimes without a slot projection on one model", () => {
    for (const source of [
      config("kimi"),
      config("goose"),
      config("copilot-cli"),
      config("aider", "aider-cli"),
      config("deepseek-harness-acp"),
    ])
      expect(gatewayModelSlots(source)).toEqual([])
  })

  it("has no slots for a configuration that cannot use Cognia models", () => {
    expect(gatewayModelSlots(config("gemini-cli"))).toEqual([])
    expect(
      gatewayModelSlots({
        ...config("opencode-server", "opencode", "sse"),
        network: { endpoint: "http://127.0.0.1:4096" },
      } as ExternalAgentConfig)
    ).toEqual([])
  })

  it("records the pinned upstream evidence on every slot", () => {
    for (const slot of [
      ...gatewayModelSlots(config("claude-code")),
      ...gatewayModelSlots(config("codex-app-server", "codex-app-server")),
      ...gatewayModelSlots(config("opencode-acp")),
    ])
      expect(slot.evidence).toMatch(/v\d|rust-v\d/)
  })
})
