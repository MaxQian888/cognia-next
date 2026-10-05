import {
  distinguishingTraits,
  groupByRuntimeFamily,
  instanceDifferences,
  runtimeFamilyKey,
  runtimeSiblings,
  sharedStateSiblings,
  type InstanceFamilyConfig,
} from "./instance-family"

function config(overrides: Partial<InstanceFamilyConfig> & { id: string }): InstanceFamilyConfig {
  return {
    name: overrides.id,
    protocol: "acp",
    transport: "stdio",
    process: { command: "codex", args: ["app-server"] },
    metadata: { preset: "codex-app-server" },
    ...overrides,
  } as InstanceFamilyConfig
}

describe("runtimeFamilyKey", () => {
  it("joins every surface of one preset family", () => {
    expect(runtimeFamilyKey(config({ id: "a", metadata: { preset: "codex" } }))).toBe(
      runtimeFamilyKey(config({ id: "b", metadata: { preset: "codex-app-server" } }))
    )
  })

  it("keys a hand-configured agent by its executable or npx package", () => {
    expect(
      runtimeFamilyKey(
        config({ id: "a", metadata: {}, process: { command: "/opt/homebrew/bin/codex" } })
      )
    ).toBe("command:codex")
    expect(
      runtimeFamilyKey(
        config({
          id: "b",
          metadata: {},
          process: { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
        })
      )
    ).toBe("command:@zed-industries/codex-acp")
    expect(
      runtimeFamilyKey(config({ id: "c", metadata: {}, process: { command: "kimi.exe" } }))
    ).toBe("command:kimi")
  })

  it("does not join hand-configured agents through the add form's custom marker", () => {
    const custom = (id: string, command: string) =>
      config({ id, metadata: { preset: "custom" }, process: { command } })
    expect(runtimeFamilyKey(custom("a", "goose"))).toBe("command:goose")
    expect(runtimeFamilyKey(custom("b", "aider"))).toBe("command:aider")
  })

  it("keys a network agent by protocol and endpoint origin", () => {
    const network = (endpoint: string) =>
      config({
        id: endpoint,
        metadata: {},
        transport: "http",
        protocol: "opencode-v2",
        process: undefined,
        network: { endpoint },
      })
    expect(runtimeFamilyKey(network("http://127.0.0.1:4096/v1"))).toBe(
      runtimeFamilyKey(network("http://127.0.0.1:4096/other"))
    )
    expect(runtimeFamilyKey(network("not a url"))).toBe("endpoint:opencode-v2:not a url")
  })
})

describe("groupByRuntimeFamily / runtimeSiblings", () => {
  it("groups in first-seen order and keeps member order", () => {
    const a = config({ id: "a" })
    const pi = config({ id: "pi", metadata: { preset: "pi" }, process: { command: "pi" } })
    const b = config({ id: "b", metadata: { preset: "codex" } })
    const groups = groupByRuntimeFamily([a, pi, b])
    expect(groups.map((group) => group.members.map((member) => member.id))).toEqual([
      ["a", "b"],
      ["pi"],
    ])
    expect(runtimeSiblings(a, [a, pi, b]).map((member) => member.id)).toEqual(["b"])
  })
})

describe("sharedStateSiblings", () => {
  it("finds shared configurations writing the same home", () => {
    const a = config({ id: "a" })
    const b = config({ id: "b", metadata: {}, process: { command: "codex" } })
    const isolated = config({ id: "iso", stateIsolation: "isolated" })
    const pi = config({ id: "pi", metadata: { preset: "pi" }, process: { command: "pi" } })
    expect(sharedStateSiblings(a, [a, b, isolated, pi]).map((member) => member.id)).toEqual(["b"])
    expect(sharedStateSiblings(isolated, [a, b, isolated])).toEqual([])
  })

  it("never treats the npx cache as shared state", () => {
    const one = config({
      id: "one",
      metadata: {},
      process: { command: "npx", args: ["-y", "@google/gemini-cli"] },
    })
    const two = config({
      id: "two",
      metadata: {},
      process: { command: "npx", args: ["-y", "opencode-ai"] },
    })
    expect(sharedStateSiblings(one, [one, two])).toEqual([])
  })

  it("has nothing to share for a network agent", () => {
    const remote = config({
      id: "remote",
      transport: "http",
      process: undefined,
      network: { endpoint: "http://x" },
    })
    expect(sharedStateSiblings(remote, [remote, config({ id: "a" })])).toEqual([])
  })
})

describe("instanceDifferences / distinguishingTraits", () => {
  it("lists only the settings that differ, in a fixed order", () => {
    const readOnly = config({
      id: "ro",
      defaultPermissionMode: "plan",
      codexOptions: { sandboxMode: "readOnly", networkAccess: false },
    })
    const writer = config({
      id: "rw",
      defaultPermissionMode: "acceptEdits",
      stateIsolation: "isolated",
      codexOptions: { sandboxMode: "workspaceWrite", networkAccess: false },
      cogniaModel: { providerId: "openai", modelId: "gpt-5.6" },
      maxConcurrentSessions: 2,
      requireApprovalFor: ["Bash"],
    })
    expect(instanceDifferences(writer, readOnly)).toEqual([
      { key: "permissionMode", value: "acceptEdits", otherValue: "plan" },
      { key: "stateIsolation", value: "isolated", otherValue: "shared" },
      { key: "model", value: "openai/gpt-5.6", otherValue: null },
      { key: "sandbox", value: "workspaceWrite", otherValue: "readOnly" },
      { key: "sessionLimit", value: "2", otherValue: null },
      { key: "approvals", value: "?Bash", otherValue: null },
    ])
  })

  it("collects each differing key once across every sibling", () => {
    const self = config({
      id: "self",
      defaultPermissionMode: "plan",
      process: { command: "codex", cwd: "/a" },
    })
    const one = config({
      id: "one",
      defaultPermissionMode: "default",
      process: { command: "codex", cwd: "/a" },
    })
    const two = config({
      id: "two",
      defaultPermissionMode: "plan",
      process: { command: "codex", cwd: "/b" },
    })
    expect(distinguishingTraits(self, [one, two])).toEqual([
      { key: "permissionMode", value: "plan" },
      { key: "workingDirectory", value: "/a" },
    ])
    expect(distinguishingTraits(self, [])).toEqual([])
  })

  it("does not report isolation for network agents", () => {
    const remote = (id: string, stateIsolation?: "isolated") =>
      config({
        id,
        transport: "http",
        process: undefined,
        stateIsolation,
        network: { endpoint: "http://x" },
      })
    expect(instanceDifferences(remote("a", "isolated"), remote("b"))).toEqual([])
  })
})
