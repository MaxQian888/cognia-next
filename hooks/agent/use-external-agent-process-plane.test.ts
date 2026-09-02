/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import {
  __setProcessPlaneDepsForTests,
  PROCESS_PLANE_COMMANDS,
} from "@/lib/ai/agent/external/process-plane"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"

import { useExternalAgentProcessPlane } from "./use-external-agent-process-plane"

/**
 * A companion whose Host has not reported its features yet, then one that has.
 *
 * The verdict is driven off the runtime snapshot rather than the remote-host
 * store because the snapshot has a public writer, which is what lets the test
 * move the world the way a real handshake does.
 */
function unpairedDeps(): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => false,
  })
}

const HOST_ONLINE = {
  target: { id: "host-a", kind: "companion", hostKind: "desktop", platform: "web" },
  vaultState: "unlocked",
  connectionState: "online",
  host: {
    compatible: true,
    operations: ["spawn_external_agent"],
    grants: ["process.spawn"],
  },
} as const

describe("useExternalAgentProcessPlane", () => {
  let restore: (() => void) | undefined

  beforeEach(() => {
    restore = unpairedDeps()
    setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
  })

  afterEach(() => {
    restore?.()
    restore = undefined
    setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
  })

  it("answers the current verdict", () => {
    const { result } = renderHook(() => useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn))
    expect(result.current).toEqual({ ok: false, reason: "no-host" })
  })

  it("re-renders when the Host finishes reporting what it supports", () => {
    // The failure this hook exists for. Sampled once from render, the panel
    // disables its Connect button on the mid-handshake verdict and then has no
    // reactive input left that could ever bring it back.
    const { result } = renderHook(() => useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn))
    expect(result.current.ok).toBe(false)

    act(() => {
      setRuntimeSnapshot(HOST_ONLINE as never)
    })
    expect(result.current).toEqual({ ok: true, via: "remote" })
  })

  it("keeps one object while the answer holds still", () => {
    // The verdict is a fresh object per call, so an unstable snapshot would
    // make `useSyncExternalStore` see a change on every check.
    const { result, rerender } = renderHook(() =>
      useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)
    )
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("answers per operation, because a Host can ship one arm and not another", () => {
    act(() => {
      setRuntimeSnapshot(HOST_ONLINE as never)
    })
    const spawn = renderHook(() => useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn))
    const detect = renderHook(() => useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.detect))
    expect(spawn.result.current.ok).toBe(true)
    expect(detect.result.current).toEqual({ ok: false, reason: "unsupported" })
  })
})
