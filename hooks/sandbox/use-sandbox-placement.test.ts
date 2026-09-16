/** @jest-environment jsdom */

const listeners = new Map<string, (payload: unknown) => void>()
const unlisten = jest.fn()
const onTauriEvent = jest.fn(async (event: string, handler: (payload: unknown) => void) => {
  listeners.set(event, handler)
  return unlisten
})

jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (event: string, handler: (payload: unknown) => void) =>
    onTauriEvent(event, handler),
}))

import { act, renderHook } from "@testing-library/react"

import { useSandboxPlacement } from "./use-sandbox-placement"
import {
  __resetPlacementReportsForTests,
  recordPlacementReport,
} from "@/lib/sandbox/placement-report"
import {
  __resetRunEnvironmentForTests,
  recordRunEnvironmentOutcome,
} from "@/lib/sandbox/run-environment"
import { SANDBOX_PLACEMENT_CHANNEL } from "@/types/sandbox/environment-spec"

beforeEach(() => {
  listeners.clear()
  unlisten.mockClear()
  onTauriEvent.mockClear()
  __resetPlacementReportsForTests()
  __resetRunEnvironmentForTests()
})

describe("useSandboxPlacement", () => {
  it("reads both halves that already arrived before the mount", () => {
    recordRunEnvironmentOutcome("a1", { kind: "off" })
    recordPlacementReport({ agentId: "a1", kind: "sandbox", tier: "gvisor" })

    const { result } = renderHook(() => useSandboxPlacement("a1"))

    expect(result.current.requested).toEqual({ kind: "off" })
    expect(result.current.report?.tier).toBe("gvisor")
  })

  it("follows the brain's verdict as it is recorded", () => {
    const { result } = renderHook(() => useSandboxPlacement("a1"))

    act(() => {
      recordRunEnvironmentOutcome("a1", {
        kind: "fallback",
        code: "sandbox_fallback_pool_disabled",
        notices: [],
      })
    })

    expect(result.current.requested).toEqual({
      kind: "fallback",
      code: "sandbox_fallback_pool_disabled",
      notices: [],
    })
  })

  // The tier, the user and the digests can all differ from the request, so a
  // surface has to read the Host's own answer. This is the wire that carries
  // it.
  it("records what arrives on the placement channel", () => {
    const { result } = renderHook(() => useSandboxPlacement("a1"))
    expect(onTauriEvent).toHaveBeenCalledWith(SANDBOX_PLACEMENT_CHANNEL, expect.any(Function))

    act(() => {
      listeners.get(SANDBOX_PLACEMENT_CHANNEL)?.({
        agentId: "a1",
        placement: {
          kind: "sandbox",
          isolationTier: "container",
          user: { name: "node", uid: 1000, gid: 1000, remappedFrom: null },
          egress: { tier: "allowlist", enforced: false },
        },
      })
    })

    expect(result.current.report).toMatchObject({
      kind: "sandbox",
      tier: "container",
      user: "node",
      egressEnforced: false,
    })
  })

  it("ignores another agent's report", () => {
    recordRunEnvironmentOutcome("a1", { kind: "off" })
    const { result } = renderHook(() => useSandboxPlacement("a1"))

    act(() => {
      recordPlacementReport({ agentId: "a2", kind: "sandbox", tier: "vm" })
    })

    expect(result.current.report).toBeUndefined()
  })

  // A panel that switches runs must not keep showing the previous one's
  // sandbox.
  it("re-reads both halves when the agent changes", () => {
    recordRunEnvironmentOutcome("a1", { kind: "off" })
    recordPlacementReport({ agentId: "a2", kind: "sandbox", tier: "vm" })

    const { result, rerender } = renderHook(({ id }) => useSandboxPlacement(id), {
      initialProps: { id: "a1" as string | undefined },
    })
    expect(result.current.report).toBeUndefined()

    rerender({ id: "a2" })
    expect(result.current.requested).toBeUndefined()
    expect(result.current.report?.tier).toBe("vm")

    rerender({ id: undefined })
    expect(result.current.requested).toBeUndefined()
    expect(result.current.report).toBeUndefined()
  })

  // The subscribe is async, so an unmount can land before it resolves. The
  // listener must still be torn down — otherwise a panel opened and closed
  // quickly leaks one subscription per visit.
  it("stops listening on unmount, including one that beats the subscribe", async () => {
    const { unmount } = renderHook(() => useSandboxPlacement("a1"))
    unmount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(unlisten).toHaveBeenCalled()
  })

  // A browser with no companion, or a Host older than ADR-0182, has no
  // placement channel. The requested half must still render rather than the
  // panel failing to mount.
  it("survives a host with no placement channel", () => {
    onTauriEvent.mockRejectedValueOnce(new Error("no such event"))
    recordRunEnvironmentOutcome("a1", { kind: "off" })

    const { result } = renderHook(() => useSandboxPlacement("a1"))

    expect(result.current.requested).toEqual({ kind: "off" })
  })
})
