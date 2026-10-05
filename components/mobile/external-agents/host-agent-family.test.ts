import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import {
  groupHostConfigsByRuntime,
  hostAgentName,
  lineageSourceOf,
  presetOf,
  runtimeKeyOf,
  siblingDifferences,
  siblingsOf,
  stateIsolationOf,
} from "./host-agent-family"

function record(
  configId: string,
  config: Partial<ExternalAgentConfigRecord["config"]> = {}
): ExternalAgentConfigRecord {
  return {
    configId,
    revision: `${configId}_r`,
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { name: configId, protocol: "acp", transport: "stdio", ...config },
  } as ExternalAgentConfigRecord
}

const codexA = record("a", {
  name: "Codex RO",
  metadata: { preset: "codex" },
  process: { command: "codex-acp" },
  defaultPermissionMode: "plan",
  codexOptions: { sandboxMode: "readOnly" },
})
const codexB = record("b", {
  name: "Codex RW",
  metadata: { preset: "codex" },
  process: { command: "codex-acp", cwd: "/work", args: ["--x"] },
  stateIsolation: "isolated",
  duplicatedFromAgentId: "a",
  cogniaModel: { providerId: "openai", modelId: "gpt-5" },
  codexOptions: { sandboxMode: "workspaceWrite" },
})
const customPi = record("c", { process: { command: "/usr/local/bin/pi" } })
const customPi2 = record("d", { process: { command: "pi" } })
const remote = record("e", { protocol: "a2a", transport: "http" })

const customA = record("f", { process: { command: "mine" }, metadata: { preset: "custom" } })
const customB = record("g", { process: { command: "theirs" }, metadata: { preset: "custom" } })

describe("runtime identity", () => {
  it("is the preset, then the command's executable, then the endpoint", () => {
    const codexKey = runtimeKeyOf(codexA)
    // Keyed by the preset family, named after the configuration's own preset.
    expect(codexKey).toMatchObject({ kind: "preset", id: "codex" })
    expect(codexKey.key).toBe(runtimeKeyOf(record("y", { metadata: { preset: "codex-acp" } })).key)
    expect(runtimeKeyOf(customPi)).toEqual({ kind: "command", command: "pi", key: "command:pi" })
    expect(runtimeKeyOf(remote).kind).toBe("single")
    expect(presetOf(record("x", { metadata: { preset: "custom" } }))).toBeNull()
  })

  // The add form records `preset: "custom"` for a hand-configured agent; that
  // names no runtime, so two different commands must not become one family.
  it("does not treat the custom marker as a runtime", () => {
    expect(runtimeKeyOf(customA).key).toBe("command:mine")
    expect(siblingsOf(customA, [customA, customB])).toEqual([])
  })

  it("names a configuration, falling back to its id", () => {
    expect(hostAgentName(codexA)).toBe("Codex RO")
    expect(hostAgentName(record("z", { name: "  " }))).toBe("z")
  })
})

describe("siblingsOf / groupHostConfigsByRuntime", () => {
  const all = [codexA, customPi, codexB, remote, customPi2]

  it("finds other configurations of the same runtime", () => {
    expect(siblingsOf(codexA, all).map((r) => r.configId)).toEqual(["b"])
    expect(siblingsOf(customPi, all).map((r) => r.configId)).toEqual(["d"])
    expect(siblingsOf(remote, all)).toEqual([])
  })

  it("groups in first-appearance order, keeping the records", () => {
    const groups = groupHostConfigsByRuntime(all)
    expect(groups.map((g) => [g.runtime.kind, g.records.map((r) => r.configId)])).toEqual([
      ["preset", ["a", "b"]],
      ["command", ["c", "d"]],
      ["single", ["e"]],
    ])
    expect(groups[0].records[0]).toBe(codexA)
  })
})

describe("lineage and isolation", () => {
  it("treats an absent isolation as shared", () => {
    expect(stateIsolationOf(codexA)).toBe("shared")
    expect(stateIsolationOf(codexB)).toBe("isolated")
  })

  it("resolves the source of a copy, and says when it is gone", () => {
    expect(lineageSourceOf(codexB, [codexA, codexB])).toBe(codexA)
    expect(lineageSourceOf(codexB, [codexB])).toBe("removed")
    expect(lineageSourceOf(codexA, [codexA, codexB])).toBeNull()
  })
})

describe("siblingDifferences", () => {
  it("lists what the sibling sets differently, with the sibling's values", () => {
    const differences = siblingDifferences(codexA, codexB)
    expect(differences.map((d) => [d.key, d.value])).toEqual(
      expect.arrayContaining([
        ["stateIsolation", "isolated"],
        ["model", "openai/gpt-5"],
        ["workingDirectory", "/work"],
        ["arguments", "--x"],
        ["sandbox", "workspaceWrite"],
      ])
    )
    expect(siblingDifferences(codexB, codexA)).toContainEqual(
      expect.objectContaining({ key: "model", value: null })
    )
  })

  it("is empty for identical settings", () => {
    expect(siblingDifferences(codexA, { ...codexA, configId: "a2" })).toEqual([])
  })
})
