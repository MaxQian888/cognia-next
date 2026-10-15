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

jest.mock("@/lib/project-environment/environment-client", () => ({
  environmentDeliveryList: jest.fn(),
}))

import { transport, setTransport } from "@/lib/tauri/transport-instance"
import { environmentDeliveryList } from "@/lib/project-environment/environment-client"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import { act, renderHook, waitFor } from "@testing-library/react"

import { useSandboxPlacement } from "./use-sandbox-placement"
import {
  __resetPlacementReportsForTests,
  recordPlacementReport,
  recordTaskDelivery,
} from "@/lib/sandbox/placement-report"
import {
  __resetRunEnvironmentForTests,
  recordRunEnvironmentOutcome,
} from "@/lib/sandbox/run-environment"
import {
  SANDBOX_PLACEMENT_CHANNEL,
  WORKSPACE_PUBLISH_CHANNEL,
} from "@/types/sandbox/environment-spec"

const initialHostTransport = transport

beforeEach(() => {
  jest
    .mocked(environmentDeliveryList)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}))
  setTransport(initialHostTransport)
  __resetRoutingForTests()
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

const savedDelivery = {
  id: "session-1",
  agentId: "a1",
  providerId: "e2b",
  instanceId: "box",
  branch: "task/one",
  publishState: "savedBundle" as const,
  cleanupState: "destroyRetrying" as const,
  publish: { recovery: { bundle: "/host/sandbox-recovery/work.bundle" } },
  createdAt: 100,
  updatedAt: 200,
  revision: 2,
}

it("hydrates an ended session after reload without receiving any events", async () => {
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [savedDelivery] })
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() =>
    expect(result.current.report?.publish?.recovery?.bundle).toBe(
      "/host/sandbox-recovery/work.bundle"
    )
  )
  expect(result.current.deliveries).toHaveLength(1)
  expect(result.current.deliveryStatus).toBe("ready")
})

it("does not regress a live cleanup update when the initial snapshot arrives later", async () => {
  let resolve!: (value: { items: (typeof savedDelivery)[] }) => void
  jest.mocked(environmentDeliveryList).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(environmentDeliveryList).toHaveBeenCalled())
  act(() => recordTaskDelivery({ ...savedDelivery, revision: 3, cleanupState: "destroyed" }))
  await act(async () => resolve({ items: [savedDelivery] }))
  expect(result.current.report?.delivery?.cleanupState).toBe("destroyed")
})

it("clears the visible Host scope immediately and ignores its outstanding read after switching", async () => {
  let resolve!: (value: { items: (typeof savedDelivery)[] }) => void
  jest.mocked(environmentDeliveryList).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(environmentDeliveryList).toHaveBeenCalled())
  act(() => recordTaskDelivery(savedDelivery))
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [] })
  const remote = { call: jest.fn(), subscribe: jest.fn(() => () => {}) } as Transport
  act(() => setActiveRemoteTransport(remote))
  expect(result.current.report).toBeUndefined()
  await act(async () => resolve({ items: [savedDelivery] }))
  expect(result.current.deliveries).toHaveLength(0)
})

it("refreshes persisted cleanup state after focus and keeps earlier records on a failed refresh", async () => {
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [savedDelivery] })
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(result.current.deliveryStatus).toBe("ready"))
  jest
    .mocked(environmentDeliveryList)
    .mockResolvedValue({ items: [{ ...savedDelivery, revision: 3, cleanupState: "destroyed" }] })
  act(() => window.dispatchEvent(new Event("focus")))
  await waitFor(() => expect(result.current.report?.delivery?.cleanupState).toBe("destroyed"))
  jest.mocked(environmentDeliveryList).mockRejectedValue(new Error("connection lost"))
  act(() => window.dispatchEvent(new Event("online")))
  await waitFor(() => expect(result.current.deliveryStatus).toBe("failed"))
  expect(result.current.deliveries).toHaveLength(1)
})

it("rebinds a replaced browser companion transport without reusing the previous Host's outcomes", async () => {
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [savedDelivery] })
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(result.current.deliveries).toHaveLength(1))
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [] })
  const replacement = { call: jest.fn(), subscribe: jest.fn(() => () => {}) } as Transport
  act(() => setTransport(replacement))
  expect(result.current.report).toBeUndefined()
  await waitFor(() => expect(result.current.deliveryStatus).toBe("ready"))
  expect(result.current.deliveries).toHaveLength(0)
})

it("treats a browser without a Host as unavailable", async () => {
  jest
    .mocked(environmentDeliveryList)
    .mockRejectedValue({ code: "no_host_transport", message: "No host" })
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(result.current.deliveryStatus).toBe("unavailable"))
})

it("does not attach historical publish state to a newer placement arriving during hydration", async () => {
  let resolve!: (value: { items: (typeof savedDelivery)[] }) => void
  jest.mocked(environmentDeliveryList).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(environmentDeliveryList).toHaveBeenCalled())
  act(() =>
    recordPlacementReport({
      agentId: "a1",
      kind: "sandbox",
      provider: "new-provider",
      image: "new-image",
    })
  )
  await act(async () => resolve({ items: [savedDelivery] }))
  expect(result.current.report?.provider).toBe("new-provider")
  expect(result.current.report?.publish).toBeUndefined()
  expect(result.current.deliveries).toHaveLength(1)
})

it("preserves a placement already live before mount against old hydration and old cleanup events", async () => {
  recordPlacementReport({
    agentId: "a1",
    kind: "sandbox",
    provider: "new-provider",
    image: "new-image",
    deliveryRecordId: "new-session",
  })
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [savedDelivery] })
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(result.current.deliveryStatus).toBe("ready"))
  expect(result.current.report).toMatchObject({
    provider: "new-provider",
    image: "new-image",
    deliveryRecordId: "new-session",
  })
  expect(result.current.report?.publish).toBeUndefined()

  act(() =>
    listeners.get(WORKSPACE_PUBLISH_CHANNEL)?.({
      agentId: "a1",
      publish: { deliveryRecord: { ...savedDelivery, revision: 3, cleanupState: "destroyed" } },
    })
  )
  expect(result.current.report?.provider).toBe("new-provider")
  expect(result.current.report?.publish).toBeUndefined()
  expect(result.current.deliveries[0].cleanupState).toBe("destroyed")

  act(() =>
    listeners.get(WORKSPACE_PUBLISH_CHANNEL)?.({
      agentId: "a1",
      publish: {
        deliveryRecord: {
          ...savedDelivery,
          id: "new-session",
          providerId: "new-provider",
          createdAt: 300,
          publishState: "pushed",
          publish: { pushed: true, commit: "new-commit" },
        },
      },
    })
  )
  expect(result.current.report?.publish).toMatchObject({ pushed: true, commit: "new-commit" })
  expect(result.current.report?.image).toBe("new-image")
})

it("keeps uncorrelated live placements separate from historical sessions", async () => {
  recordPlacementReport({ agentId: "a1", kind: "sandbox", provider: "unlinked-provider" })
  jest.mocked(environmentDeliveryList).mockResolvedValue({ items: [savedDelivery] })
  const { result } = renderHook(() => useSandboxPlacement("a1"))
  await waitFor(() => expect(result.current.deliveryStatus).toBe("ready"))
  expect(result.current.report?.provider).toBe("unlinked-provider")
  expect(result.current.report?.publish).toBeUndefined()
  expect(result.current.deliveries).toHaveLength(1)
})
