/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import {
  __resetOfferedHostStateActionsForTesting,
  publishOfferedHostStateActions,
  refreshOfferedHostStateActions,
} from "@/lib/sync/host-state-offered-actions"

import { useHostStateActionOffered } from "./use-host-state-action-offered"

function pairWith(runtimeTargetId: string) {
  setRuntimeSnapshot({
    target: null,
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: ["host_state_submit"],
      grants: [],
      hostStateScope: { accountId: "acct", runtimeTargetId },
    },
  })
}

beforeEach(() => {
  __resetRuntimeSnapshotForTesting()
  __resetOfferedHostStateActionsForTesting()
})

describe("useHostStateActionOffered", () => {
  it("offers everything while nothing is known", () => {
    const { result } = renderHook(() => useHostStateActionOffered("session.workspace"))
    expect(result.current).toBe(true)
  })

  it("follows the paired Host's answer for its declared scope", () => {
    act(() => pairWith("host-target"))
    publishOfferedHostStateActions("host-target", ["session.rename"])
    const { result } = renderHook(() => useHostStateActionOffered("session.workspace"))
    expect(result.current).toBe(false)

    act(() => refreshOfferedHostStateActions("host-target", ["session.workspace"]))
    expect(result.current).toBe(true)

    // Another Host's answer is not this one's.
    act(() => pairWith("other-target"))
    act(() => refreshOfferedHostStateActions("host-target", ["session.rename"]))
    expect(result.current).toBe(true)
  })
})
