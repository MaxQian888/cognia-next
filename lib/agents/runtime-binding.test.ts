import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import {
  applyAgentRuntimeToSession,
  isSameRuntimeBinding,
  resolveRuntimeBinding,
  runtimeBindingFromRef,
  runtimeBindingKey,
  type ApplyAgentRuntimeDeps,
} from "./runtime-binding"

function hostRecord(patch: Partial<ExternalAgentConfigRecord> = {}): ExternalAgentConfigRecord {
  return {
    configId: "cfg-1",
    revision: "eacr_2",
    lifecycleGeneration: 7,
    seq: 1,
    config: { name: "Codex on host" } as ExternalAgentConfigRecord["config"],
    enabled: true,
    lifecycleStatus: "ready" as ExternalAgentConfigRecord["lifecycleStatus"],
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

function deps(patch: Partial<ApplyAgentRuntimeDeps> = {}): ApplyAgentRuntimeDeps {
  return {
    hasLocalExternalAgent: (id) => id === "codex",
    getHostConfig: async (id) => (id === "cfg-1" ? hostRecord() : null),
    setSessionRuntimeRef: jest.fn(),
    selectExternalAgent: jest.fn(),
    ...patch,
  }
}

describe("runtimeBindingFromRef", () => {
  it("drops the host admission stamp and keeps a label", () => {
    expect(
      runtimeBindingFromRef({
        kind: "host",
        configId: "cfg-1",
        revision: "eacr_1",
        lifecycleGeneration: 3,
        name: "Host Codex",
      })
    ).toEqual({ kind: "host", configId: "cfg-1", name: "Host Codex" })
    expect(runtimeBindingFromRef({ kind: "external", agentId: "codex" }, "Codex")).toEqual({
      kind: "external",
      agentId: "codex",
      name: "Codex",
    })
    expect(runtimeBindingFromRef({ kind: "builtin" })).toEqual({ kind: "builtin" })
  })
})

describe("runtimeBindingKey", () => {
  it("matches the catalog key of the lane it resolves to", () => {
    expect(runtimeBindingKey(undefined)).toBe("builtin")
    expect(runtimeBindingKey({ kind: "builtin" })).toBe("builtin")
    expect(runtimeBindingKey({ kind: "external", agentId: "codex" })).toBe("external:codex")
    expect(runtimeBindingKey({ kind: "host", configId: "cfg-1" })).toBe("host:cfg-1")
  })

  it("compares bindings by lane and target, not label", () => {
    expect(
      isSameRuntimeBinding(
        { kind: "external", agentId: "a", name: "A" },
        { kind: "external", agentId: "a" }
      )
    ).toBe(true)
    expect(isSameRuntimeBinding(undefined, { kind: "builtin" })).toBe(true)
    expect(isSameRuntimeBinding({ kind: "external", agentId: "a" }, { kind: "builtin" })).toBe(
      false
    )
  })
})

describe("resolveRuntimeBinding", () => {
  it("re-reads the host stamp at resolution time", async () => {
    await expect(
      resolveRuntimeBinding({ kind: "host", configId: "cfg-1", name: "old" }, deps())
    ).resolves.toEqual({
      ok: true,
      ref: {
        kind: "host",
        configId: "cfg-1",
        revision: "eacr_2",
        lifecycleGeneration: 7,
        name: "Codex on host",
      },
    })
  })

  it("never substitutes a missing target", async () => {
    await expect(
      resolveRuntimeBinding({ kind: "external", agentId: "gone" }, deps())
    ).resolves.toEqual({ ok: false, reason: "missing-external-agent" })
    await expect(
      resolveRuntimeBinding({ kind: "host", configId: "nope" }, deps())
    ).resolves.toEqual({ ok: false, reason: "missing-host-config" })
    await expect(
      resolveRuntimeBinding(
        { kind: "host", configId: "cfg-1" },
        deps({ getHostConfig: async () => hostRecord({ enabled: false }) })
      )
    ).resolves.toEqual({ ok: false, reason: "missing-host-config" })
    await expect(
      resolveRuntimeBinding(
        { kind: "host", configId: "cfg-1" },
        deps({ getHostConfig: async () => hostRecord({ tombstonedAt: 5 }) })
      )
    ).resolves.toEqual({ ok: false, reason: "missing-host-config" })
    await expect(
      resolveRuntimeBinding(
        { kind: "host", configId: "cfg-1" },
        deps({
          getHostConfig: async () => {
            throw new Error("offline")
          },
        })
      )
    ).resolves.toEqual({ ok: false, reason: "host-unreachable" })
  })
})

describe("applyAgentRuntimeToSession", () => {
  it("does nothing for an agent without a default runtime", async () => {
    const d = deps()
    await expect(applyAgentRuntimeToSession("s1", {}, d)).resolves.toBeUndefined()
    expect(d.setSessionRuntimeRef).not.toHaveBeenCalled()
  })

  it("pins the session and mirrors the manager's active agent for an external lane", async () => {
    const d = deps()
    await applyAgentRuntimeToSession("s1", { runtime: { kind: "external", agentId: "codex" } }, d)
    expect(d.selectExternalAgent).toHaveBeenCalledWith("codex")
    expect(d.setSessionRuntimeRef).toHaveBeenCalledWith("s1", {
      kind: "external",
      agentId: "codex",
    })
  })

  it("leaves the session alone and reports why when the target is gone", async () => {
    const d = deps()
    await expect(
      applyAgentRuntimeToSession("s1", { runtime: { kind: "external", agentId: "gone" } }, d)
    ).resolves.toEqual({ ok: false, reason: "missing-external-agent" })
    expect(d.setSessionRuntimeRef).not.toHaveBeenCalled()
    expect(d.selectExternalAgent).not.toHaveBeenCalled()
  })
})
