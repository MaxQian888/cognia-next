/** @jest-environment node */

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type {
  CreateExternalAgentInput,
  ExternalAgentProtocol,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import { resetAcpRegistryCacheForTests } from "../acp-registry"

import {
  ExternalAgentLifecycleService,
  isRuntimeAffectingUpdate,
  type LifecycleAdapterRegistry,
  type LifecycleConfigStore,
  type LifecycleDependencies,
  type LifecycleRuntimeHost,
  type LifecycleRuntimeManager,
} from "./service"
import type { LifecycleAgentConfig } from "./credentials"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeStore(seed: LifecycleAgentConfig[] = []) {
  const agents = new Map(seed.map((config) => [config.id, { ...config }]))
  let counter = 0

  const store: LifecycleConfigStore & { agents: Map<string, LifecycleAgentConfig> } = {
    agents,
    getAgent: (id) => agents.get(id),
    getAllAgents: () => [...agents.values()],
    addAgent: (input: CreateExternalAgentInput) => {
      counter += 1
      const id = `agent-${counter}`
      agents.set(id, { id, enabled: true, ...input } as LifecycleAgentConfig)
      return id
    },
    updateAgent: (id, updates: UpdateExternalAgentInput) => {
      const existing = agents.get(id)
      if (existing) agents.set(id, { ...existing, ...updates } as LifecycleAgentConfig)
    },
    removeAgent: (id) => {
      agents.delete(id)
    },
    replaceAgentConfig: (id, config) => {
      if (agents.has(id)) agents.set(id, { ...config, id })
    },
    patchLifecycle: (id, fields) => {
      const existing = agents.get(id)
      if (!existing) return
      const next = { ...existing } as Record<string, unknown>
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      agents.set(id, next as unknown as LifecycleAgentConfig)
    },
    setConnectionStatus: jest.fn(),
  }
  return store
}

function fakeManager() {
  const instances = new Map<string, { sessions: Map<string, unknown> }>()
  const calls: string[] = []

  const manager: LifecycleRuntimeManager & {
    instances: Map<string, { sessions: Map<string, unknown> }>
    calls: string[]
    failNextAdd?: Error
  } = {
    instances,
    calls,
    addAgent: jest.fn(async (config) => {
      if (manager.failNextAdd) {
        const error = manager.failNextAdd
        manager.failNextAdd = undefined
        calls.push(`addAgent:fail:${config.id}`)
        throw error
      }
      calls.push(`addAgent:${config.id}`)
      instances.set(config.id, { sessions: new Map() })
      return instances.get(config.id)
    }),
    removeAgent: jest.fn(async (id) => {
      calls.push(`removeAgent:${id}`)
      instances.delete(id)
    }),
    connect: jest.fn(async (id) => {
      calls.push(`connect:${id}`)
    }),
    disconnect: jest.fn(async (id) => {
      calls.push(`disconnect:${id}`)
    }),
    getAgent: (id) => instances.get(id),
    closeSession: jest.fn(async (agentId, sessionId) => {
      calls.push(`closeSession:${agentId}:${sessionId}`)
      instances.get(agentId)?.sessions.delete(sessionId)
    }),
  }
  return manager
}

function memoryKeyring(): KeyringStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    save: async (k, v) => {
      entries.set(k, v)
    },
    load: async (k) => entries.get(k) ?? null,
    delete: async (k) => {
      entries.delete(k)
    },
  }
}

function build(overrides: Partial<LifecycleDependencies> = {}, seed: LifecycleAgentConfig[] = []) {
  const store = overrides.store
    ? (overrides.store as ReturnType<typeof fakeStore>)
    : fakeStore(seed)
  const manager = overrides.manager
    ? (overrides.manager as ReturnType<typeof fakeManager>)
    : fakeManager()
  const keyring = (overrides.keyring as ReturnType<typeof memoryKeyring>) ?? memoryKeyring()
  const adapters: LifecycleAdapterRegistry = overrides.adapters ?? {
    isProtocolAvailable: () => true,
  }

  const deps: LifecycleDependencies = {
    store,
    manager,
    adapters,
    keyring,
    platform: "darwin",
    hostId: "host-1",
    policyRevision: 1,
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    ...overrides,
    // Keep the concrete fakes even when overrides supplied partial ones.
    ...(overrides.store ? {} : { store }),
    ...(overrides.manager ? {} : { manager }),
  }

  return {
    service: new ExternalAgentLifecycleService(deps),
    store,
    manager,
    keyring,
    deps,
  }
}

function stdioConfig(overrides: Partial<LifecycleAgentConfig> = {}): LifecycleAgentConfig {
  return {
    id: "agent-1",
    name: "Codex",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "codex", args: ["app-server"] },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe("assessReadiness and version certification", () => {
  it("stays ready on an uncertified runtime version — certification is informational", () => {
    // DELIBERATE, and pinned here so it is not "fixed" by accident.
    //
    // `assessRuntimeVersion` fails closed on `missing`, and `missing` is what a
    // runtime whose binary is not on PATH reports. Feeding the version verdict
    // into readiness would therefore block EVERY agent on any machine that has
    // not installed that particular CLI, which is far worse than the problem it
    // would solve. So the verdict drives the governance panel and the consent
    // receipt, never admission.
    //
    // The one thing that DOES gate is `verdictFailsClosed`, applied where a
    // launch is actually attempted — not here.
    return build()
      .service.assessReadiness(stdioConfig())
      .then((verdict) => {
        expect(verdict.status).toBe("ready")
      })
  })
})

describe("isRuntimeAffectingUpdate", () => {
  it("treats launch-shaping fields as runtime-affecting", () => {
    expect(isRuntimeAffectingUpdate({ process: { command: "x" } })).toBe(true)
    expect(isRuntimeAffectingUpdate({ network: { endpoint: "https://a" } })).toBe(true)
    expect(isRuntimeAffectingUpdate({ timeout: 5 })).toBe(true)
    expect(isRuntimeAffectingUpdate({ retryConfig: { maxRetries: 2 } })).toBe(true)
  })

  it("does not tear down the runtime for cosmetic edits", () => {
    expect(isRuntimeAffectingUpdate({ name: "New name" })).toBe(false)
    expect(isRuntimeAffectingUpdate({ description: "d", tags: ["t"] })).toBe(false)
  })

  it("detects a field that is present but undefined", () => {
    expect(isRuntimeAffectingUpdate({ process: undefined })).toBe(true)
  })
})

describe("createConfig", () => {
  it("registers an enabled agent with the runtime immediately", async () => {
    const { service, manager } = build()

    const id = await service.createConfig(stdioConfig() as unknown as CreateExternalAgentInput)

    // The bug this replaces: Settings persisted the config and the manager did
    // not learn about it until the next app restart.
    expect(manager.addAgent).toHaveBeenCalledTimes(1)
    expect(manager.getAgent(id)).toBeDefined()
  })

  it("does not register a disabled agent", async () => {
    const { service, manager } = build()
    await service.createConfig({
      ...stdioConfig(),
      enabled: false,
    } as unknown as CreateExternalAgentInput)
    expect(manager.addAgent).not.toHaveBeenCalled()
  })

  it("moves an inline secret to the keyring before persisting the config", async () => {
    const { service, store, keyring } = build()

    const id = await service.createConfig({
      ...stdioConfig({
        transport: "http",
        network: { endpoint: "https://a.test", apiKey: "sk-secret" },
      }),
    } as unknown as CreateExternalAgentInput)

    expect(JSON.stringify(store.getAgent(id))).not.toContain("sk-secret")
    expect(keyring.entries.get(`${id}:apiKey`)).toBe("sk-secret")
    expect(store.getAgent(id)?.credentialRefs?.apiKey).toBe(`${id}:apiKey`)
  })

  it("keeps the config but records why when registration fails", async () => {
    const { service, store, manager } = build()
    manager.failNextAdd = new Error("spawn ENOENT")

    const id = await service.createConfig(stdioConfig() as unknown as CreateExternalAgentInput)

    const saved = store.getAgent(id)
    expect(saved).toBeDefined()
    expect(saved?.enabled).toBe(false)
    expect(saved?.lifecycleStatus).toBe("blocked")
    expect(saved?.lifecycleReason).toContain("spawn ENOENT")
    expect(store.setConnectionStatus).toHaveBeenCalledWith(id, "error")
  })
})

describe("updateConfig", () => {
  it("rebuilds the runtime for a launch-shaping edit, tearing down before persisting", async () => {
    const { service, manager, store } = build({}, [stdioConfig()])
    await service.connect("agent-1")
    manager.calls.length = 0

    await service.updateConfig("agent-1", { process: { command: "codex", args: ["--acp"] } })

    // Order matters: the old adapter must be gone before the new config is
    // persisted, or the store and the live adapter disagree.
    expect(manager.calls).toEqual(["removeAgent:agent-1", "addAgent:agent-1"])
    expect(store.getAgent("agent-1")?.process?.args).toEqual(["--acp"])
  })

  it("leaves the runtime alone for a cosmetic edit", async () => {
    const { service, manager } = build({}, [stdioConfig()])
    await service.connect("agent-1")
    manager.calls.length = 0

    await service.updateConfig("agent-1", { name: "Renamed" })

    expect(manager.calls).toEqual([])
  })

  it("tears the runtime down when the agent is disabled", async () => {
    const { service, manager } = build({}, [stdioConfig()])
    await service.connect("agent-1")
    manager.calls.length = 0

    await service.updateConfig("agent-1", { enabled: false })

    expect(manager.calls).toEqual(["removeAgent:agent-1"])
    expect(manager.getAgent("agent-1")).toBeUndefined()
  })

  it("registers the agent when it is re-enabled", async () => {
    const { service, manager } = build({}, [stdioConfig({ enabled: false })])

    await service.updateConfig("agent-1", { enabled: true })

    expect(manager.getAgent("agent-1")).toBeDefined()
  })

  it("rebuilds when a new secret is supplied, since the launch env changes", async () => {
    const { service, manager, keyring } = build({}, [
      stdioConfig({ transport: "http", network: { endpoint: "https://a.test" } }),
    ])
    await service.connect("agent-1")
    manager.calls.length = 0

    await service.updateConfig("agent-1", { network: { bearerToken: "tok" } })

    expect(manager.calls).toEqual(["removeAgent:agent-1", "addAgent:agent-1"])
    expect(keyring.entries.get("agent-1:bearerToken")).toBe("tok")
  })

  it("refuses an unknown agent with a stable code", async () => {
    const { service } = build()
    await expect(service.updateConfig("nope", { name: "x" })).rejects.toMatchObject({
      code: "runtime_missing",
    })
  })
})

describe("removeConfig", () => {
  it("ends sessions, drops the manager state, then deletes the record and secrets", async () => {
    const { service, store, manager, keyring } = build({}, [stdioConfig()])
    await service.connect("agent-1")
    await service.setCredentials("agent-1", { apiKey: "sk-secret" })
    manager.instances.get("agent-1")!.sessions.set("s1", {})
    manager.instances.get("agent-1")!.sessions.set("s2", {})
    manager.calls.length = 0

    await service.removeConfig("agent-1")

    // The old path deleted the record first and left the process running.
    expect(manager.calls).toEqual([
      "closeSession:agent-1:s1",
      "closeSession:agent-1:s2",
      "removeAgent:agent-1",
    ])
    expect(store.getAgent("agent-1")).toBeUndefined()
    expect(keyring.entries.size).toBe(0)
  })

  it("still tears the runtime down when a session refuses to close", async () => {
    const { service, manager } = build({}, [stdioConfig()])
    await service.connect("agent-1")
    manager.instances.get("agent-1")!.sessions.set("s1", {})
    manager.closeSession = jest.fn(async () => {
      throw new Error("session wedged")
    })

    await service.removeConfig("agent-1")

    expect(manager.removeAgent).toHaveBeenCalledWith("agent-1")
    expect(manager.getAgent("agent-1")).toBeUndefined()
  })

  it("removes a config that was never registered", async () => {
    const { service, store } = build({}, [stdioConfig({ enabled: false })])
    await service.removeConfig("agent-1")
    expect(store.getAgent("agent-1")).toBeUndefined()
  })
})

describe("connect", () => {
  it("refuses when no protocol adapter is registered, naming the reason", async () => {
    const { service, store } = build({ adapters: { isProtocolAvailable: () => false } }, [
      // Plugin-contributed protocols are `${pluginId}:${id}` at runtime but are
      // not in the `ExternalAgentProtocol` union, so the cast mirrors what the
      // manager already does when it branches on `protocol.includes(":")`.
      stdioConfig({ protocol: "acme:custom" as ExternalAgentProtocol }),
    ])

    await expect(service.connect("agent-1")).rejects.toMatchObject({
      code: "adapter_unavailable",
    })
    expect(store.getAgent("agent-1")?.lifecycleStatus).toBe("blocked")
    expect(store.getAgent("agent-1")?.lifecycleReason).toContain("acme:custom")
  })

  it("refuses when a credential reference has no keyring entry", async () => {
    const { service } = build({}, [stdioConfig({ credentialRefs: { apiKey: "agent-1:apiKey" } })])

    await expect(service.connect("agent-1")).rejects.toMatchObject({
      code: "credential_missing",
    })
  })

  it("does not double-connect an enabled agent that addAgent already connected", async () => {
    const { service, manager } = build({}, [stdioConfig()])
    await service.connect("agent-1")
    expect(manager.connect).not.toHaveBeenCalled()
  })
})

describe("reconcile", () => {
  it("disables and explains rather than auto-connecting an agent it cannot start", async () => {
    const { service, store, manager } = build({ adapters: { isProtocolAvailable: () => false } }, [
      stdioConfig({ protocol: "plugin:gone" as ExternalAgentProtocol }),
    ])

    const verdicts = await service.reconcile()

    expect(verdicts.get("agent-1")?.reasonCode).toBe("adapter_unavailable")
    expect(store.getAgent("agent-1")?.enabled).toBe(false)
    expect(manager.addAgent).not.toHaveBeenCalled()
  })

  it("stops a live agent whose config has since become invalid", async () => {
    let available = true
    const { service, manager } = build({ adapters: { isProtocolAvailable: () => available } }, [
      stdioConfig(),
    ])
    await service.connect("agent-1")
    expect(manager.getAgent("agent-1")).toBeDefined()

    available = false
    await service.reconcile()

    expect(manager.getAgent("agent-1")).toBeUndefined()
  })

  it("registers enabled agents that are not yet live", async () => {
    const { service, manager } = build({}, [stdioConfig(), stdioConfig({ id: "agent-2" })])

    const verdicts = await service.reconcile()

    expect([...verdicts.values()].every((v) => v.status === "ready")).toBe(true)
    expect(manager.getAgent("agent-1")).toBeDefined()
    expect(manager.getAgent("agent-2")).toBeDefined()
  })
})

describe("session accounting", () => {
  it("counts live sessions from the manager rather than assuming zero", async () => {
    const { service, manager } = build({}, [
      stdioConfig({ runtimeBinding: { runtimeId: "deepseek-harness", ownership: "managed" } }),
    ])
    await service.connect("agent-1")
    manager.instances.get("agent-1")!.sessions.set("s1", {})

    expect(service.activeSessionCount("agent-1")).toBe(1)
    expect(service.activeSessionsForRuntime("deepseek-harness")).toBe(1)
  })

  it("sums sessions across every agent bound to the runtime", async () => {
    const binding = { runtimeId: "deepseek-harness", ownership: "managed" as const }
    const { service, manager } = build({}, [
      stdioConfig({ runtimeBinding: binding }),
      stdioConfig({ id: "agent-2", runtimeBinding: binding }),
    ])
    await service.reconcile()
    manager.instances.get("agent-1")!.sessions.set("s1", {})
    manager.instances.get("agent-2")!.sessions.set("s2", {})
    manager.instances.get("agent-2")!.sessions.set("s3", {})

    expect(service.activeSessionsForRuntime("deepseek-harness")).toBe(3)
  })

  it("reports zero for an unbound runtime", () => {
    const { service } = build({}, [stdioConfig()])
    expect(service.activeSessionsForRuntime("deepseek-harness")).toBe(0)
  })
})

describe("uninstallRuntime", () => {
  function withHost(seed: LifecycleAgentConfig[]) {
    const host: LifecycleRuntimeHost = {
      inspect: jest.fn(),
      install: jest.fn(),
      checkForUpdate: jest.fn(),
      update: jest.fn(),
      rollback: jest.fn(),
      uninstall: jest.fn(async () => {}),
    } as unknown as LifecycleRuntimeHost
    return { ...build({ runtimeHost: host }, seed), host }
  }

  it("refuses while a session is live", async () => {
    const binding = { runtimeId: "deepseek-harness", ownership: "managed" as const }
    const { service, manager, host } = withHost([stdioConfig({ runtimeBinding: binding })])
    await service.connect("agent-1")
    manager.instances.get("agent-1")!.sessions.set("s1", {})

    await expect(service.uninstallRuntime("deepseek-harness")).rejects.toMatchObject({
      code: "active_sessions",
    })
    expect(host.uninstall).not.toHaveBeenCalled()
  })

  it("refuses while a configuration still references it", async () => {
    const binding = { runtimeId: "deepseek-harness", ownership: "managed" as const }
    const { service, host } = withHost([stdioConfig({ enabled: false, runtimeBinding: binding })])

    await expect(service.uninstallRuntime("deepseek-harness")).rejects.toMatchObject({
      code: "runtime_referenced",
    })
    expect(host.uninstall).not.toHaveBeenCalled()
  })

  it("never removes a runtime the user's own package manager owns", async () => {
    const { service, host } = withHost([])
    await expect(service.uninstallRuntime("codex-app-server")).rejects.toMatchObject({
      code: "runtime_referenced",
    })
    expect(host.uninstall).not.toHaveBeenCalled()
  })

  it("removes a managed runtime nothing depends on", async () => {
    const { service, host } = withHost([])
    await service.uninstallRuntime("deepseek-harness")
    expect(host.uninstall).toHaveBeenCalledWith("deepseek-harness")
  })

  it("refuses an unknown runtime", async () => {
    const { service } = withHost([])
    await expect(service.uninstallRuntime("nope")).rejects.toMatchObject({
      code: "runtime_missing",
    })
  })

  it("records what the probe saw onto every agent bound to that runtime", async () => {
    // The consent check compares an approval against the binding. If a probe's
    // findings never land there, the binding has no digest and no version, and
    // the executable/version invalidations can never fire.
    const { service, store, host } = withHost([
      stdioConfig({ runtimeBinding: { runtimeId: "codex-acp", ownership: "system" } }),
      stdioConfig({
        id: "agent-2",
        runtimeBinding: { runtimeId: "droid", ownership: "system" },
      }),
    ])
    ;(host.inspect as jest.Mock).mockResolvedValue({
      assessment: {
        runtimeId: "codex-acp",
        verdict: "supported-uncertified",
        detectedVersion: "1.2.3",
        executablePath: "/usr/bin/codex-acp",
        executableDigest: "e".repeat(64),
        checkedAt: "2026-08-22T12:00:00.000Z",
      },
    })

    await service.inspectRuntime("codex-acp")

    expect(store.getAgent("agent-1")?.runtimeBinding).toMatchObject({
      resolvedExecutablePath: "/usr/bin/codex-acp",
      pinnedVersion: "1.2.3",
      executableDigest: "e".repeat(64),
    })
    // …and leaves an agent bound to a different runtime alone.
    expect(store.getAgent("agent-2")?.runtimeBinding).toEqual({
      runtimeId: "droid",
      ownership: "system",
    })
  })

  it("reports honestly on a host that cannot install anything", async () => {
    const { service } = build({}, [])
    await expect(service.installRuntime("deepseek-harness")).rejects.toMatchObject({
      code: "platform_unsupported",
    })
  })
})

describe("Windows unsandboxed consent", () => {
  /** A config bound to an eligible runtime, as `createConfig`/`reviewAll` bind it. */
  const boundConfig = (binding: Record<string, unknown> = {}) =>
    stdioConfig({
      runtimeBinding: {
        runtimeId: "codex-acp",
        ownership: "system",
        resolvedExecutablePath: "C:\\tools\\npx.cmd",
        pinnedVersion: "1.0.0",
        ...binding,
      },
    })

  it("refuses on macOS, where the sandbox is mandatory", async () => {
    const { service } = build({ platform: "darwin" }, [boundConfig()])
    await expect(service.grantUnsandboxedWindowsConsent("agent-1")).rejects.toMatchObject({
      code: "platform_unsupported",
    })
  })

  it("refuses on Linux, where the sandbox is mandatory", async () => {
    const { service } = build({ platform: "linux" }, [boundConfig()])
    await expect(service.grantUnsandboxedWindowsConsent("agent-1")).rejects.toMatchObject({
      code: "platform_unsupported",
    })
  })

  it("refuses a runtime the catalog does not mark eligible", async () => {
    const { service } = build({ platform: "win32" }, [boundConfig({ runtimeId: "droid" })])
    await expect(service.grantUnsandboxedWindowsConsent("agent-1")).rejects.toMatchObject({
      code: "platform_unsupported",
    })
  })

  it("refuses an agent bound to no runtime, rather than approving an unknown command", async () => {
    const { service } = build({ platform: "win32" }, [stdioConfig()])
    await expect(service.grantUnsandboxedWindowsConsent("agent-1")).rejects.toMatchObject({
      code: "runtime_missing",
    })
  })

  it("binds consent to the host and policy revision it was given under", async () => {
    const { service, store } = build({ platform: "win32", hostId: "win-host", policyRevision: 7 }, [
      boundConfig(),
    ])

    const consent = await service.grantUnsandboxedWindowsConsent("agent-1")

    expect(consent).toMatchObject({
      agentId: "agent-1",
      hostId: "win-host",
      policyRevision: 7,
      confirmedAt: "2026-08-22T12:00:00.000Z",
    })
    expect(store.getAgent("agent-1")?.unsandboxedConsent).toEqual(consent)
    // The approval is now what the readiness check reads, so the agent stops
    // being reported as needing one.
    expect(store.getAgent("agent-1")?.lifecycleStatus).toBe("ready")
  })

  it("describes the command that would run, not one the caller supplied", async () => {
    // The UI used to hand in its own identity; it described what it displayed
    // while the check described what would run.
    const { service, store } = build({ platform: "win32", hostId: "win-host" }, [
      boundConfig({ executableDigest: "c".repeat(64) }),
    ])

    const consent = await service.grantUnsandboxedWindowsConsent("agent-1")

    expect(consent.executablePath).toBe("C:\\tools\\npx.cmd")
    expect(consent.executableDigest).toBe("c".repeat(64))
    expect(consent.runtimeVersion).toBe("1.0.0")
    expect(consent).toEqual(
      expect.objectContaining(service.launchIdentity(store.getAgent("agent-1")!)!)
    )
  })

  it("invalidates an approval once the executable underneath it changes", async () => {
    // This could not fire before: the check read the digest out of the consent
    // it was checking, so it compared a value with itself.
    const { service, store } = build({ platform: "win32", hostId: "win-host" }, [
      boundConfig({ executableDigest: "c".repeat(64) }),
    ])
    await service.grantUnsandboxedWindowsConsent("agent-1")
    expect(store.getAgent("agent-1")?.lifecycleStatus).toBe("ready")

    store.patchLifecycle("agent-1", {
      runtimeBinding: {
        ...store.getAgent("agent-1")!.runtimeBinding!,
        executableDigest: "d".repeat(64),
      },
    })

    await expect(service.connect("agent-1")).rejects.toMatchObject({ code: "consent_required" })
    expect(store.getAgent("agent-1")?.lifecycleStatus).toBe("needs-consent")
  })

  it("revoking consent removes the record and stops the agent", async () => {
    const { service, store, manager } = build({ platform: "win32", hostId: "win-host" }, [
      boundConfig(),
    ])
    await service.grantUnsandboxedWindowsConsent("agent-1")
    await service.connect("agent-1").catch(() => {})
    manager.instances.set("agent-1", { sessions: new Map() })

    await service.revokeConsent("agent-1")

    expect(store.getAgent("agent-1")?.unsandboxedConsent).toBeUndefined()
    expect(manager.getAgent("agent-1")).toBeUndefined()
    expect(store.getAgent("agent-1")?.enabled).toBe(false)
  })

  it("blocks a Windows launch whose consent no longer matches what would run", async () => {
    const { service, store } = build({ platform: "win32", hostId: "win-host" }, [
      stdioConfig({
        runtimeBinding: { runtimeId: "codex-acp", ownership: "system" },
      }),
    ])

    await expect(service.connect("agent-1")).rejects.toMatchObject({ code: "consent_required" })
    expect(store.getAgent("agent-1")?.lifecycleStatus).toBe("needs-consent")
  })
})

describe("credentials", () => {
  it("clearing credentials empties both the keyring and the references", async () => {
    const { service, store, keyring } = build({}, [stdioConfig()])
    await service.setCredentials("agent-1", { apiKey: "sk" })
    expect(keyring.entries.size).toBe(1)

    await service.clearCredentials("agent-1")

    expect(keyring.entries.size).toBe(0)
    expect(store.getAgent("agent-1")?.credentialRefs).toEqual({})
  })

  it("does not throw a lifecycle error out of readiness for an unexpected failure", async () => {
    const keyring = memoryKeyring()
    keyring.load = async () => {
      throw new TypeError("keyring exploded")
    }
    const { service } = build({ keyring }, [
      stdioConfig({ credentialRefs: { apiKey: "agent-1:apiKey" } }),
    ])

    // A programming error must surface as itself, not be laundered into a
    // "needs credentials" verdict the user cannot act on.
    await expect(service.connect("agent-1")).rejects.toBeInstanceOf(TypeError)
  })
})

describe("error contract", () => {
  it("every refusal is an ExternalAgentLifecycleError with a stable code", async () => {
    const { service } = build()
    const error = await service.updateConfig("nope", {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExternalAgentLifecycleError)
    expect((error as ExternalAgentLifecycleError).code).toBe("runtime_missing")
  })
})

describe("migrateLegacyCredentials", () => {
  const legacy = () =>
    stdioConfig({
      transport: "http",
      network: { endpoint: "https://a.test", apiKey: "sk-legacy" },
    })

  it("scrubs the plaintext and records a reference", async () => {
    const { service, store, keyring } = build({}, [legacy()])

    const result = await service.migrateLegacyCredentials()

    expect(result.migrated).toEqual(["agent-1"])
    expect(JSON.stringify(store.getAgent("agent-1"))).not.toContain("sk-legacy")
    expect(store.getAgent("agent-1")?.credentialRefs?.apiKey).toBe("agent-1:apiKey")
    expect(keyring.entries.get("agent-1:apiKey")).toBe("sk-legacy")
  })

  it("uses a wholesale replace, because updateAgent could never remove a field", async () => {
    const { service, store } = build({}, [legacy()])
    await service.migrateLegacyCredentials()
    // `updateAgent` merges `network`, so a merge-based migration would leave
    // the apiKey exactly where it was.
    expect(store.getAgent("agent-1")?.network?.apiKey).toBeUndefined()
    expect(store.getAgent("agent-1")?.network?.endpoint).toBe("https://a.test")
  })

  it("skips agents that carry no inline secret", async () => {
    const { service, keyring } = build({}, [stdioConfig()])
    const result = await service.migrateLegacyCredentials()
    expect(result.migrated).toEqual([])
    expect(keyring.entries.size).toBe(0)
  })

  it("contains a keyring failure to one agent and still scrubs it", async () => {
    const keyring = memoryKeyring()
    keyring.save = async () => {
      throw new Error("vault locked")
    }
    const { service, store } = build({ keyring }, [legacy(), stdioConfig({ id: "agent-2" })])

    const result = await service.migrateLegacyCredentials()

    expect(result.failed).toEqual([{ agentId: "agent-1", reason: "vault locked" }])
    expect(JSON.stringify(store.getAgent("agent-1"))).not.toContain("sk-legacy")
    expect(store.getAgent("agent-1")?.enabled).toBe(false)
    // Boot continues: the healthy agent is untouched.
    expect(store.getAgent("agent-2")?.enabled).toBe(true)
  })

  it("disables the agent when the store itself refuses the replacement", async () => {
    const store = fakeStore([legacy()])
    store.replaceAgentConfig = () => {
      throw new Error("store write failed")
    }
    const { service } = build({ store })

    const result = await service.migrateLegacyCredentials()

    expect(result.failed[0]).toMatchObject({ agentId: "agent-1" })
    expect(store.getAgent("agent-1")?.enabled).toBe(false)
    expect(store.getAgent("agent-1")?.lifecycleStatus).toBe("needs-credentials")
  })
})

describe("reviewAll", () => {
  it("judges and disables without connecting anything", async () => {
    const { service, manager, store } = build({ adapters: { isProtocolAvailable: () => false } }, [
      stdioConfig(),
    ])

    const verdicts = await service.reviewAll()

    expect(verdicts.get("agent-1")?.reasonCode).toBe("adapter_unavailable")
    expect(store.getAgent("agent-1")?.enabled).toBe(false)
    expect(manager.addAgent).not.toHaveBeenCalled()
  })

  it("leaves a ready agent unregistered, since rehydration owns that", async () => {
    const { service, manager } = build({}, [stdioConfig()])

    const verdicts = await service.reviewAll()

    expect(verdicts.get("agent-1")?.status).toBe("ready")
    // reconcile() registers; reviewAll() deliberately does not, so startup
    // rehydration does not end up registering every agent twice.
    expect(manager.addAgent).not.toHaveBeenCalled()
  })
})

describe("registry discovery", () => {
  const REGISTRY = {
    version: "1.0.0",
    agents: [
      {
        id: "binary-agent",
        name: "Binary Agent",
        version: "1.2.3",
        description: "installable",
        website: "https://example.test",
        distribution: {
          binary: {
            "darwin-arm64": {
              archive: "https://example.test/a.tar.gz",
              sha256: "c".repeat(64),
              cmd: "bin/agent",
            },
          },
        },
      },
      {
        id: "npx-agent",
        name: "Npx Agent",
        version: "2.0.0",
        description: "discovery only",
        distribution: { npx: { package: "@example/npx-agent" } },
      },
    ],
  }

  beforeEach(() => {
    resetAcpRegistryCacheForTests()
    global.fetch = (async () =>
      new Response(JSON.stringify(REGISTRY), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
  })

  it("classifies the listing and remembers only what it can install", async () => {
    const { service } = build()

    const result = await service.discoverRegistryRuntimes("darwin-arm64")

    expect(result.entries.map((entry) => entry.kind)).toEqual(["managed", "user-managed"])
    // The npx entry is discovery only: there is no approved frozen lock for an
    // arbitrary registry package.
    expect([...service.discoveredRuntimeEntries()].map((entry) => entry.runtimeId)).toEqual([
      "registry:binary-agent",
    ])
  })

  it("certifies nothing about a discovered runtime", async () => {
    const { service } = build()
    await service.discoverRegistryRuntimes("darwin-arm64")

    const [entry] = [...service.discoveredRuntimeEntries()]
    expect(entry.supportedRange).toBeUndefined()
    expect(entry.certifiedVersions).toBeUndefined()
    expect(entry.platforms).toEqual(["darwin"])
  })

  it("lets inspectRuntime resolve a discovered runtime", async () => {
    const runtimeHost = {
      inspect: jest.fn(async () => ({
        assessment: {
          runtimeId: "registry:binary-agent",
          verdict: "supported-uncertified" as const,
          checkedAt: "2026-08-22T12:00:00.000Z",
        },
      })),
      install: jest.fn(),
      checkForUpdate: jest.fn(),
      update: jest.fn(),
      rollback: jest.fn(),
      uninstall: jest.fn(),
    } as unknown as LifecycleRuntimeHost
    const { service } = build({ runtimeHost })
    await service.discoverRegistryRuntimes("darwin-arm64")

    const status = await service.inspectRuntime("registry:binary-agent")

    expect(status.ownership).toBe("managed")
    expect(status.assessment.verdict).toBe("supported-uncertified")
  })

  it("still refuses a runtime nobody discovered or catalogued", async () => {
    const { service } = build({ runtimeHost: {} as unknown as LifecycleRuntimeHost })
    await expect(service.inspectRuntime("registry:ghost")).rejects.toMatchObject({
      code: "runtime_missing",
    })
  })
})

describe("runtime bindings", () => {
  const preset = (id: string, overrides: Partial<LifecycleAgentConfig> = {}) =>
    stdioConfig({ metadata: { preset: id }, ...overrides })

  it("binds a new config to its runtime without the caller knowing one", async () => {
    const { service, store } = build()

    const id = await service.createConfig(
      preset("droid", {
        process: { command: "droid", args: ["exec"] },
      }) as unknown as CreateExternalAgentInput
    )

    expect(store.getAgent(id)?.runtimeBinding).toEqual({
      runtimeId: "droid",
      ownership: "system",
    })
  })

  it("honours a binding the caller supplied", async () => {
    const { service, store } = build()
    const id = await service.createConfig({
      ...preset("droid"),
      runtimeBinding: { runtimeId: "deepseek-harness", ownership: "managed" },
    } as unknown as CreateExternalAgentInput)

    expect(store.getAgent(id)?.runtimeBinding?.runtimeId).toBe("deepseek-harness")
  })

  it("leaves a config it cannot match unbound rather than guessing", async () => {
    const { service, store } = build()
    const id = await service.createConfig(
      stdioConfig({ process: { command: "mystery-binary" } }) as unknown as CreateExternalAgentInput
    )
    expect(store.getAgent(id)?.runtimeBinding).toBeUndefined()
  })

  it("backfills configs saved before the catalog existed", async () => {
    const { service, store } = build({}, [
      preset("droid", { id: "agent-1", process: { command: "droid", args: ["exec"] } }),
      preset("gemini-cli", {
        id: "agent-2",
        process: { command: "npx", args: ["-y", "@google/gemini-cli", "--acp"] },
      }),
      stdioConfig({ id: "agent-3", process: { command: "mystery-binary" } }),
    ])

    expect(service.backfillRuntimeBindings()).toBe(2)
    expect(store.getAgent("agent-1")?.runtimeBinding?.runtimeId).toBe("droid")
    expect(store.getAgent("agent-2")?.runtimeBinding?.runtimeId).toBe("gemini-cli")
    expect(store.getAgent("agent-3")?.runtimeBinding).toBeUndefined()
  })

  it("never overwrites an existing binding", async () => {
    const { service, store } = build({}, [
      preset("droid", { runtimeBinding: { runtimeId: "deepseek-harness", ownership: "managed" } }),
    ])

    expect(service.backfillRuntimeBindings()).toBe(0)
    expect(store.getAgent("agent-1")?.runtimeBinding?.runtimeId).toBe("deepseek-harness")
  })

  it("runs the backfill as part of startup review", async () => {
    const { service, store } = build({}, [
      preset("droid", { process: { command: "droid", args: ["exec"] } }),
    ])

    await service.reviewAll()

    expect(store.getAgent("agent-1")?.runtimeBinding?.runtimeId).toBe("droid")
  })

  it("makes the uninstall guards fire, which they could not without a binding", async () => {
    // This is the consequence that was broken: with no binding, every agent's
    // sessions were attributed to no runtime, so `activeSessionsForRuntime`
    // returned 0 and both uninstall guards were unreachable.
    const runtimeHost = {
      inspect: jest.fn(),
      install: jest.fn(),
      checkForUpdate: jest.fn(),
      update: jest.fn(),
      rollback: jest.fn(),
      uninstall: jest.fn(async () => {}),
    } as unknown as LifecycleRuntimeHost
    const { service, manager } = build({ runtimeHost }, [
      preset("deepseek-harness-readonly", {
        process: { command: "/managed/dsh/bin/agent", args: [] },
      }),
    ])

    await service.reviewAll()
    manager.instances.set("agent-1", { sessions: new Map([["s1", {}]]) })

    expect(service.activeSessionsForRuntime("deepseek-harness")).toBe(1)
    await expect(service.uninstallRuntime("deepseek-harness")).rejects.toMatchObject({
      code: "active_sessions",
    })

    manager.instances.get("agent-1")!.sessions.clear()
    await expect(service.uninstallRuntime("deepseek-harness")).rejects.toMatchObject({
      code: "runtime_referenced",
    })
    expect(runtimeHost.uninstall).not.toHaveBeenCalled()
  })
})
