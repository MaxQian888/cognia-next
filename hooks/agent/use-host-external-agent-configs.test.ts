/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import {
  useHostExternalAgentConfigs,
  useHostSupportsModelRoles,
} from "./use-host-external-agent-configs"
import {
  HOST_CONFIG_COMMANDS,
  HOST_CONFIG_CAPABILITIES,
  __setRemoteHostConfigDepsForTests,
  type RemoteHostConfigDeps,
} from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

let mockHostScope = "host:first"
const mockHostListeners = new Set<() => void>()
jest.mock("@/lib/ai/agent/external/capability/process-plane", () => ({
  externalAgentProcessPlaneScope: () => mockHostScope,
  subscribeExternalAgentProcessPlane: (listener: () => void) => {
    mockHostListeners.add(listener)
    return () => mockHostListeners.delete(listener)
  },
}))

beforeEach(() => {
  mockHostScope = "host:first"
})

const ALL_OPS = Object.values(HOST_CONFIG_COMMANDS)

function record(over: Partial<ExternalAgentConfigRecord> = {}): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { name: "Pi" },
    ...over,
  } as ExternalAgentConfigRecord
}

let restore: (() => void) | undefined
let calls: Array<{ command: string; payload?: Record<string, unknown> }>

function setup(over: Partial<RemoteHostConfigDeps> = {}, reply: (command: string) => unknown) {
  calls = []
  restore?.()
  restore = __setRemoteHostConfigDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalAuthority: () => true,
    activeHostFeatureManifest: () => null,
    getRuntimeSnapshot: () => ({ host: { compatible: true, operations: ALL_OPS } }) as never,
    call: async (command, payload) => {
      calls.push({ command, payload })
      return reply(command) as never
    },
    ...over,
  })
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("useHostExternalAgentConfigs", () => {
  it("loads the host's configurations", async () => {
    setup({}, () => ({ configs: [record()] }))
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loaded).toBe(true)
    expect(result.current.configs).toHaveLength(1)
    expect(result.current.unavailable).toBeNull()
  })

  it("reports an unreachable host instead of an empty list", async () => {
    setup({ hasLocalAuthority: () => false, getRuntimeSnapshot: () => ({}) as never }, () => ({}))
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unavailable).toBe("no-host")
    // The absence of a host must not look like "this host has none".
    expect(calls).toEqual([])
  })

  it("surfaces a failed load as an error", async () => {
    setup({}, () => {
      throw new Error("host exploded")
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("host exploded")
    expect(result.current.loaded).toBe(false)
    expect(result.current.configs).toEqual([])
  })

  it("does not claim an empty host until the first successful report", async () => {
    let resolve!: (value: unknown) => void
    setup(
      {},
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    expect(result.current.loaded).toBe(false)
    expect(result.current.loading).toBe(true)
    expect(result.current.configs).toEqual([])
    await act(async () => {
      resolve({ configs: [] })
    })
    expect(result.current.loaded).toBe(true)
    expect(result.current.loading).toBe(false)
  })

  it("retains the last successful report when a refresh fails", async () => {
    let fail = false
    setup({}, () => {
      if (fail) throw new Error("relay timeout")
      return { configs: [record()] }
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    fail = true
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.loaded).toBe(true)
    expect(result.current.configs).toEqual([record()])
    expect(result.current.error).toBe("relay timeout")
  })

  it("resets loaded on a host change and ignores the previous host's pending report", async () => {
    const replies: Array<(value: unknown) => void> = []
    setup(
      {},
      () =>
        new Promise((resolve) => {
          replies.push(resolve)
        })
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await act(async () => {
      replies[0]({ configs: [record()] })
    })
    expect(result.current.loaded).toBe(true)
    let pending!: Promise<void>
    act(() => {
      pending = result.current.refresh()
    })
    act(() => {
      mockHostScope = "host:second"
      for (const listener of mockHostListeners) listener()
    })
    expect(result.current.loaded).toBe(false)
    expect(result.current.loading).toBe(true)
    expect(result.current.configs).toEqual([])
    await act(async () => {
      replies[1]({ configs: [record({ configId: "stale" })] })
      await pending
    })
    expect(result.current.loaded).toBe(false)
    expect(result.current.configs).toEqual([])
    await act(async () => {
      replies[2]({ configs: [] })
    })
    expect(result.current.loaded).toBe(true)
    expect(result.current.configs).toEqual([])
  })

  it("keeps a failed new host unknown even after the previous host loaded", async () => {
    setup({}, () => {
      if (mockHostScope === "host:second") throw new Error("host unavailable")
      return { configs: [record()] }
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => {
      mockHostScope = "host:second"
      for (const listener of mockHostListeners) listener()
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loaded).toBe(false)
    expect(result.current.configs).toEqual([])
    expect(result.current.error).toBe("host unavailable")
  })

  it("re-reads after a write rather than patching the row locally", async () => {
    let enabled = true
    setup({}, (command) =>
      command === HOST_CONFIG_COMMANDS.list
        ? { configs: [record({ enabled })] }
        : { config: record({ enabled }) }
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    enabled = false
    await act(async () => {
      await result.current.setEnabled(record(), false)
    })
    await waitFor(() => expect(result.current.configs[0].enabled).toBe(false))
    expect(calls.map((c) => c.command)).toEqual([
      HOST_CONFIG_COMMANDS.list,
      HOST_CONFIG_COMMANDS.update,
      HOST_CONFIG_COMMANDS.list,
    ])
  })

  it("sends the revision it last read, so a concurrent edit is refused", async () => {
    setup({}, (command) =>
      command === HOST_CONFIG_COMMANDS.list ? { configs: [record()] } : { config: record() }
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setEnabled(record({ revision: "eacr_7" }), false)
    })
    expect(calls[1].payload).toMatchObject({ expectedRevision: "eacr_7" })
  })

  it("keeps a failed write visible and still refreshes", async () => {
    setup({}, (command) => {
      if (command === HOST_CONFIG_COMMANDS.list) return { configs: [record()] }
      throw new Error("conflict")
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.remove(record())
    })
    await waitFor(() => expect(result.current.error).toBe("conflict"))
    expect(calls.filter((c) => c.command === HOST_CONFIG_COMMANDS.list)).toHaveLength(2)
  })

  it("reconciles through the same write path", async () => {
    setup({}, (command) =>
      command === HOST_CONFIG_COMMANDS.list ? { configs: [] } : { outcomes: [] }
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.reconcile()
    })
    expect(calls.map((c) => c.command)).toContain(HOST_CONFIG_COMMANDS.reconcile)
  })
})

describe("copyLocal", () => {
  // `createRemoteHostConfig` shipped with no caller, so the panel's own empty
  // state ("copy a local agent across") named an action nothing implemented.
  it("imports the local configuration onto the host and re-reads the list", async () => {
    setup({}, (command) =>
      command === HOST_CONFIG_COMMANDS.list ? { configs: [] } : { config: record() }
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.copyLocal({ id: "local-1", name: "Pi" } as never)
    })

    const create = calls.find((entry) => entry.command === HOST_CONFIG_COMMANDS.create)
    // `fromImport` is what makes the host strip credentials and consents that
    // only mean something on the sending machine.
    expect(create?.payload).toMatchObject({
      fromImport: true,
      config: { id: "local-1", name: "Pi" },
    })
    expect(calls.filter((entry) => entry.command === HOST_CONFIG_COMMANDS.list)).toHaveLength(2)
  })

  it("surfaces a refusal instead of leaving the panel looking successful", async () => {
    setup({}, (command) => {
      if (command === HOST_CONFIG_COMMANDS.list) return { configs: [] }
      throw new Error("host refused the import")
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.copyLocal({ id: "local-1", name: "Pi" } as never)
    })

    expect(result.current.error).toBe("host refused the import")
  })
})

describe("capability refusals", () => {
  it("shows a Host refusal's own words, not its message key", async () => {
    // A paired Host whose manifest predates per-slot models.
    setup({ hasLocalAuthority: () => false, isRemoteHostActive: () => true }, (command) =>
      command === HOST_CONFIG_COMMANDS.list ? { configs: [] } : {}
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let outcome: Awaited<ReturnType<typeof result.current.create>> | undefined
    await act(async () => {
      outcome = await result.current.create({
        name: "Codex",
        cogniaModel: { providerId: "p", modelId: "m" },
        modelRoles: { version: 1, slots: { "subagent.default": { kind: "inherit-primary" } } },
      } as never)
    })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const en = require("@/i18n/messages/en.json")
    expect(outcome).toEqual({ ok: false, error: en.externalAgent.roleModels.hostOutdated })
    expect(result.current.error).toBe(en.externalAgent.roleModels.hostOutdated)
    expect(calls.map((entry) => entry.command)).not.toContain(HOST_CONFIG_COMMANDS.create)
  })
})

describe("create / update / remove outcomes", () => {
  // The phone's add flow navigates away on success and has to show the Host's
  // reason on failure in the same tick; `error` would only arrive a render
  // later, so the outcome is the return value.
  it("create resolves the Host's new row, without the import flag, and re-reads the list", async () => {
    const created = record({ configId: "eac_new", config: { name: "Claude" } as never })
    setup({}, (command) =>
      command === HOST_CONFIG_COMMANDS.list ? { configs: [created] } : { config: created }
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: Awaited<ReturnType<typeof result.current.create>> | undefined
    await act(async () => {
      outcome = await result.current.create({ name: "Claude", enabled: true })
    })

    expect(outcome).toEqual({ ok: true, record: created })
    const create = calls.find((entry) => entry.command === HOST_CONFIG_COMMANDS.create)
    // Configuring the Host directly is not an import: nothing is stripped.
    expect(create?.payload).toEqual({ config: { name: "Claude", enabled: true } })
    expect(calls.filter((entry) => entry.command === HOST_CONFIG_COMMANDS.list)).toHaveLength(2)
  })

  it("create resolves the Host's refusal and keeps it in error", async () => {
    setup({}, (command) => {
      if (command === HOST_CONFIG_COMMANDS.list) return { configs: [] }
      throw new Error("name already taken")
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: Awaited<ReturnType<typeof result.current.create>> | undefined
    await act(async () => {
      outcome = await result.current.create({ name: "Claude" })
    })
    expect(outcome).toEqual({ ok: false, error: "name already taken" })
    expect(result.current.error).toBe("name already taken")
    expect(result.current.busy).toBe(false)
  })

  it("duplicate asks the Host to copy the row and resolves the copy", async () => {
    const copy = record({ configId: "eac_copy", config: { name: "Pi (copy)" } as never })
    setup({}, (command) =>
      command === HOST_CONFIG_COMMANDS.list ? { configs: [record(), copy] } : { config: copy }
    )
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: Awaited<ReturnType<typeof result.current.duplicate>> | undefined
    await act(async () => {
      outcome = await result.current.duplicate(record(), {
        name: "Pi (copy)",
        stateIsolation: "isolated",
        enabled: false,
      })
    })
    expect(outcome).toEqual({ ok: true, record: copy })
    expect(calls.find((c) => c.command === HOST_CONFIG_COMMANDS.duplicate)?.payload).toEqual({
      configId: "eac_1",
      name: "Pi (copy)",
      stateIsolation: "isolated",
      enabled: false,
    })
    // The list is re-read so the copy appears without a manual refresh.
    expect(result.current.configs).toHaveLength(2)
  })

  it("duplicate resolves the Host's refusal and keeps it in error", async () => {
    setup({}, (command) => {
      if (command === HOST_CONFIG_COMMANDS.list) return { configs: [record()] }
      throw new Error("credential_missing")
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: Awaited<ReturnType<typeof result.current.duplicate>> | undefined
    await act(async () => {
      outcome = await result.current.duplicate(record())
    })
    expect(outcome).toEqual({ ok: false, error: "credential_missing" })
    expect(result.current.error).toBe("credential_missing")
  })

  it("update sends the shallow patch at the read revision and reports whether it landed", async () => {
    let refuse = false
    setup({}, (command) => {
      if (command === HOST_CONFIG_COMMANDS.list) return { configs: [record()] }
      if (refuse) throw new Error("revision conflict")
      return { config: record() }
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let landed: boolean | undefined
    await act(async () => {
      landed = await result.current.update(record({ revision: "eacr_3" }), {
        defaultPermissionMode: "plan",
      })
    })
    expect(landed).toBe(true)
    expect(calls.find((c) => c.command === HOST_CONFIG_COMMANDS.update)?.payload).toEqual({
      configId: "eac_1",
      expectedRevision: "eacr_3",
      patch: { defaultPermissionMode: "plan" },
    })

    refuse = true
    await act(async () => {
      landed = await result.current.update(record(), { enabled: false })
    })
    expect(landed).toBe(false)
    expect(result.current.error).toBe("revision conflict")
  })

  it("remove reports whether the Host removed the row", async () => {
    let refuse = false
    setup({}, (command) => {
      if (command === HOST_CONFIG_COMMANDS.list) return { configs: [record()] }
      if (refuse) throw new Error("in use")
      return { config: record() }
    })
    const { result } = renderHook(() => useHostExternalAgentConfigs())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let removed: boolean | undefined
    await act(async () => {
      removed = await result.current.remove(record())
    })
    expect(removed).toBe(true)
    expect(calls.find((c) => c.command === HOST_CONFIG_COMMANDS.delete)?.payload).toEqual({
      configId: "eac_1",
    })

    refuse = true
    await act(async () => {
      removed = await result.current.remove(record())
    })
    expect(removed).toBe(false)
    expect(result.current.error).toBe("in use")
  })
})

it("refreshes role-model support when the active Host changes its capabilities", () => {
  let supported = false
  setup(
    {
      hasLocalAuthority: () => false,
      getRuntimeSnapshot: () =>
        ({
          host: {
            compatible: true,
            operations: supported
              ? [...ALL_OPS, HOST_CONFIG_CAPABILITIES.configModelRoles]
              : ALL_OPS,
          },
        }) as never,
    },
    () => ({})
  )
  const { result } = renderHook(() => useHostSupportsModelRoles())
  expect(result.current).toBe(false)
  act(() => {
    supported = true
    for (const listener of mockHostListeners) listener()
  })
  expect(result.current).toBe(true)
  act(() => {
    supported = false
    for (const listener of mockHostListeners) listener()
  })
  expect(result.current).toBe(false)
})
