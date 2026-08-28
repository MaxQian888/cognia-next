/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useHostExternalAgentConfigs } from "./use-host-external-agent-configs"
import {
  HOST_CONFIG_COMMANDS,
  __setRemoteHostConfigDepsForTests,
  type RemoteHostConfigDeps,
} from "@/lib/ai/agent/external/remote-host-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

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
