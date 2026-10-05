import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import {
  __setHostConfigMountDepsForTests,
  hostConfigCatalogMountIsLocal,
  hostConfigLaunchConfig,
  mountHostConfigAgent,
  ownCredentialRefs,
  mountHostConfigForCatalog,
  resetHostConfigMountsForTests,
  type HostConfigMountManager,
} from "./host-config-mount"

function fakeManager() {
  const agents = new Set<string>()
  const added: string[] = []
  const addedConfigs: ExternalAgentConfig[] = []
  const removed: string[] = []
  let addDelay: Promise<void> | null = null
  let failNextAdd = false

  const manager: HostConfigMountManager & {
    added: string[]
    addedConfigs: ExternalAgentConfig[]
    removed: string[]
    holdAdd: () => () => void
    failNextAdd: () => void
  } = {
    added,
    addedConfigs,
    removed,
    getAgent: (id) => (agents.has(id) ? {} : undefined),
    addAgent: async (config) => {
      if (addDelay) await addDelay
      if (failNextAdd) {
        failNextAdd = false
        throw new Error("no adapter registered for pi-rpc")
      }
      agents.add(config.id)
      added.push(config.id)
      addedConfigs.push(config)
      return {}
    },
    removeAgent: async (id) => {
      agents.delete(id)
      removed.push(id)
    },
    holdAdd: () => {
      let release: () => void = () => {}
      addDelay = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        addDelay = null
        release()
      }
    },
    failNextAdd: () => {
      failNextAdd = true
    },
  }
  return manager
}

const CONFIG = { id: "ignored", name: "Pi", protocol: "pi-rpc" } as unknown as ExternalAgentConfig

beforeEach(() => {
  resetHostConfigMountsForTests()
})

describe("mountHostConfigAgent", () => {
  // The agent id IS the configuration id, which is what lets a picker probe
  // and a turn share one process instead of spawning rivals.
  it("mounts under the configuration id, not the config's own", async () => {
    const manager = fakeManager()
    await expect(mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)).resolves.toBe("eac_1")
    expect(manager.added).toEqual(["eac_1"])
  })

  it("reuses the mount when the revision has not moved", async () => {
    const manager = fakeManager()
    await mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)
    await mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)
    expect(manager.added).toEqual(["eac_1"])
    expect(manager.removed).toEqual([])
  })

  // Leaving the old agent mounted would run the previous command line under
  // the new revision's name, which is what the revision check exists to stop.
  it("tears the agent down when the revision moved", async () => {
    const manager = fakeManager()
    await mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)
    await mountHostConfigAgent(manager, "eac_1", "eacr_2", CONFIG)
    expect(manager.removed).toEqual(["eac_1"])
    expect(manager.added).toEqual(["eac_1", "eac_1"])
  })

  // The read of the mount table, the teardown and the re-add are one critical
  // section. Two callers starting at once must not both pass the `getAgent`
  // check and both call `addAgent`, which is the shape a picker probe racing a
  // turn actually takes.
  it("serializes two mounts of the same configuration", async () => {
    const manager = fakeManager()
    const release = manager.holdAdd()
    const first = mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)
    const second = mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)
    release()
    await Promise.all([first, second])
    expect(manager.added).toEqual(["eac_1"])
  })

  // A failed mount is swallowed by the chain so it cannot poison the next
  // caller, but it is still reported to the caller that asked for it.
  it("reports a failed mount and lets the next one succeed", async () => {
    const manager = fakeManager()
    manager.failNextAdd()
    await expect(mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)).rejects.toThrow(
      "no adapter"
    )
    await expect(mountHostConfigAgent(manager, "eac_1", "eacr_1", CONFIG)).resolves.toBe("eac_1")
  })
})

// G8: a host config's secrets are resolved by the manager's launch preparer
// from the refs the mount hands it, so the refs must arrive intact — and only
// the config's own.
describe("credential refs on a mount", () => {
  it("hands the manager the config's own refs, unresolved", async () => {
    const manager = fakeManager()
    const config = {
      ...CONFIG,
      credentialRefs: { apiKey: "eac_1:apiKey", processEnv: "eac_1:processEnv" },
    } as unknown as ExternalAgentConfig
    await mountHostConfigAgent(manager, "eac_1", "eacr_1", config)
    expect(manager.addedConfigs[0]).toMatchObject({
      id: "eac_1",
      credentialRefs: { apiKey: "eac_1:apiKey", processEnv: "eac_1:processEnv" },
    })
  })

  it("drops a legacy ref that names another config's slot", () => {
    const launched = hostConfigLaunchConfig("eac_1", {
      ...CONFIG,
      credentialRefs: { apiKey: "eac_2:apiKey", bearerToken: "eac_1:bearerToken" },
    } as unknown as ExternalAgentConfig) as ExternalAgentConfig & { credentialRefs?: unknown }
    expect(launched.credentialRefs).toEqual({ bearerToken: "eac_1:bearerToken" })
    const none = hostConfigLaunchConfig("eac_1", {
      ...CONFIG,
      credentialRefs: { apiKey: "eac_10:apiKey" },
    } as unknown as ExternalAgentConfig) as ExternalAgentConfig & { credentialRefs?: unknown }
    expect(none).not.toHaveProperty("credentialRefs")
  })

  it("matches the id up to the slot separator only", () => {
    expect(
      ownCredentialRefs({ apiKey: "eac_1x:apiKey", headers: "eac_1:headers" }, "eac_1")
    ).toEqual({ headers: "eac_1:headers" })
    expect(ownCredentialRefs(undefined, "eac_1")).toEqual({})
  })
})

describe("mountHostConfigForCatalog", () => {
  const record = {
    configId: "eac_1",
    revision: "eacr_7",
    config: { name: "Pi", protocol: "pi-rpc" },
  }

  it("mounts the host's own record at the host's own revision", async () => {
    const manager = fakeManager()
    const restore = __setHostConfigMountDepsForTests({
      readConfig: async () => record as never,
      getManager: async () => manager,
    })
    try {
      await expect(mountHostConfigForCatalog("eac_1")).resolves.toBe("eac_1")
      expect(manager.added).toEqual(["eac_1"])
      // The revision came from the record, so a second read at the same
      // revision reuses the mount rather than restarting the agent.
      await mountHostConfigForCatalog("eac_1")
      expect(manager.added).toEqual(["eac_1"])
    } finally {
      restore()
    }
  })

  // A conversation can outlive the configuration it was bound to. That is an
  // ordinary answer the picker renders as "nothing to show", not a failure.
  it("answers null when the host no longer has the configuration", async () => {
    const manager = fakeManager()
    const restore = __setHostConfigMountDepsForTests({
      readConfig: async () => null,
      getManager: async () => manager,
    })
    try {
      await expect(mountHostConfigForCatalog("eac_gone")).resolves.toBeNull()
      expect(manager.added).toEqual([])
    } finally {
      restore()
    }
  })

  // The read goes out before the manager is even resolved, so a host that
  // refuses the call must not look like a manager problem.
  it("propagates a refusal from the host", async () => {
    const restore = __setHostConfigMountDepsForTests({
      readConfig: async () => {
        throw new Error("The paired host does not support external_agent_config_get.")
      },
      getManager: async () => fakeManager(),
    })
    try {
      await expect(mountHostConfigForCatalog("eac_1")).rejects.toThrow("does not support")
    } finally {
      restore()
    }
  })
})

describe("hostConfigCatalogMountIsLocal", () => {
  it("allows a catalog mount where the agent's process starts in this shell", () => {
    const restore = __setHostConfigMountDepsForTests({
      processPlane: () => ({ ok: true, via: "local" }),
    })
    try {
      expect(hostConfigCatalogMountIsLocal()).toBe(true)
    } finally {
      restore()
    }
  })

  // On a paired phone the mount spawned a second copy of the agent on the
  // Host, under the process id of the copy the Host's run service drives.
  it("refuses it where the spawn would cross to a paired Host", () => {
    const restore = __setHostConfigMountDepsForTests({
      processPlane: () => ({ ok: true, via: "remote" }),
    })
    try {
      expect(hostConfigCatalogMountIsLocal()).toBe(false)
    } finally {
      restore()
    }
  })

  it("refuses it where no process can start at all", () => {
    const restore = __setHostConfigMountDepsForTests({
      processPlane: () => ({ ok: false, reason: "no-host" }),
    })
    try {
      expect(hostConfigCatalogMountIsLocal()).toBe(false)
    } finally {
      restore()
    }
  })
})
