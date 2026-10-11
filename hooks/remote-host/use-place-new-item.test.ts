/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { usePlaceNewItem } from "./use-place-new-item"

const item = { ref: { kind: "scheduled-task" as const, id: "t1" }, label: "Digest" }

function withHosts(hosts: unknown[]) {
  useRemoteHostStore.setState({ hosts: hosts as never })
}

beforeEach(() => withHosts([]))

it("places a new item on the always-on host by default", () => {
  withHosts([{ id: "mini", label: "Mac mini", alwaysOn: true, lastProbe: { at: 1, ok: true } }])
  const { result } = renderHook(() => usePlaceNewItem())
  expect(result.current.target?.id).toBe("mini")
  expect(result.current.choice).toBe("host")
  act(() => result.current.place(item))
  expect(result.current.placing).toEqual(item)
  act(() => result.current.done())
  expect(result.current.placing).toBeNull()
})

it("keeps it here when the user chose this device", () => {
  withHosts([{ id: "mini", label: "Mac mini", alwaysOn: true, lastProbe: { at: 1, ok: true } }])
  const { result } = renderHook(() => usePlaceNewItem())
  act(() => result.current.setChoice("here"))
  act(() => result.current.place(item))
  expect(result.current.placing).toBeNull()
})

it("keeps it here when no always-on host is up", () => {
  withHosts([{ id: "mini", label: "Mac mini", alwaysOn: true, lastProbe: { at: 1, ok: false } }])
  const { result } = renderHook(() => usePlaceNewItem())
  expect(result.current.target).toBeNull()
  act(() => result.current.place(item))
  expect(result.current.placing).toBeNull()
})
