/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { useRuntimeSnapshot } from "./use-runtime-snapshot"

afterEach(() => {
  __resetRuntimeSnapshotForTesting()
})

it("reacts to runtime target and connection changes", () => {
  const { result } = renderHook(() => useRuntimeSnapshot())

  act(() => {
    setRuntimeSnapshot({
      target: {
        id: "desktop-studio",
        kind: "companion",
        platform: "web",
        hostKind: "desktop",
      },
      vaultState: "unlocked",
      connectionState: "connecting",
    })
  })

  expect(result.current.target?.id).toBe("desktop-studio")
  expect(result.current.connectionState).toBe("connecting")
})
