import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"

import {
  combineHarness,
  externalHarnessKey,
  harnessFromProvider,
  harnessFromTeammateRuntime,
} from "./harness"

describe("externalHarnessKey", () => {
  it("folds every Codex surface and the import source into one key", () => {
    expect(externalHarnessKey("codex-app-server")).toBe("ext:codex")
    expect(externalHarnessKey("codex-acp")).toBe("ext:codex")
    expect(externalHarnessKey("codex")).toBe("ext:codex")
  })

  it("strips transport and mode suffixes", () => {
    expect(externalHarnessKey("pi-rpc")).toBe("ext:pi")
    expect(externalHarnessKey("opencode-server")).toBe("ext:opencode")
    expect(externalHarnessKey("opencode-acp")).toBe("ext:opencode")
    expect(externalHarnessKey("opencode-v2-service")).toBe("ext:opencode")
    expect(externalHarnessKey("claude-code-subagent")).toBe("ext:claude-code")
    expect(externalHarnessKey("deepseek-harness-readonly")).toBe("ext:deepseek-harness")
  })

  it("keeps single-surface presets as named", () => {
    expect(externalHarnessKey("claude-code")).toBe("ext:claude-code")
    expect(externalHarnessKey("Gemini-CLI")).toBe("ext:gemini-cli")
  })
})

describe("harnessFromProvider", () => {
  const presets: Record<string, string> = { cfg1: "codex-app-server" }
  const resolve = (id: string) => presets[id]

  it("treats any Cognia provider, or none, as the built-in lane", () => {
    expect(harnessFromProvider("anthropic", resolve)).toBe("builtin")
    expect(harnessFromProvider(undefined, resolve)).toBe("builtin")
  })

  it("resolves an external-agent marker through its configuration's preset", () => {
    expect(harnessFromProvider(externalAgentProviderId("cfg1"), resolve)).toBe("ext:codex")
  })

  it("is unknown when the configuration is gone or the marker is legacy", () => {
    expect(harnessFromProvider(externalAgentProviderId("gone"), resolve)).toBeNull()
    expect(harnessFromProvider("cognia:external-agent", resolve)).toBeNull()
  })
})

describe("harnessFromTeammateRuntime", () => {
  it("maps absent and claude to builtin, presets to ext keys", () => {
    expect(harnessFromTeammateRuntime(undefined)).toBe("builtin")
    expect(harnessFromTeammateRuntime("claude")).toBe("builtin")
    expect(harnessFromTeammateRuntime("codex")).toBe("ext:codex")
  })
})

describe("combineHarness", () => {
  it("returns the single shared key", () => {
    expect(combineHarness(["builtin", "builtin"])).toBe("builtin")
  })

  it("returns mixed for several harnesses", () => {
    expect(combineHarness(["builtin", "ext:codex"])).toBe("mixed")
  })

  it("is unknown when empty or any part is unknown", () => {
    expect(combineHarness([])).toBeNull()
    expect(combineHarness(["builtin", null])).toBeNull()
  })
})
