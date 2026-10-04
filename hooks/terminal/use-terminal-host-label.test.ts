/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useTerminalHostLabel } from "./use-terminal-host-label"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

beforeEach(() => {
  useTerminalStore.getState().reset()
  useRemoteHostStore.setState({ hosts: [], activeHostId: null })
})

it("tracks host renames and preserves the captured label after removal", () => {
  useRemoteHostStore.setState({ hosts: [{ id: "registry-a", label: "New name" } as RemoteHost] })
  useTerminalStore.getState().registerSession({
    id: "s-1",
    projectId: null,
    extensionId: null,
    origin: "remote",
    shell: "zsh",
    hostId: "durable-a",
    remoteHost: { id: "registry-a", label: "Original name" },
  })
  const row = useTerminalStore.getState().sessions["s-1"]
  const { result } = renderHook(() => useTerminalHostLabel(row))
  expect(result.current).toMatchObject({ label: "New name", different: true })
  act(() => useRemoteHostStore.setState({ hosts: [] }))
  expect(result.current.label).toBe("Original name")
  act(() => useRemoteHostStore.setState({ activeHostId: "registry-a" }))
  expect(result.current.different).toBe(false)
})

it("does not mistake an unattributed remote row for this desktop", () => {
  useTerminalStore.getState().registerSession({
    id: "s-1",
    projectId: null,
    extensionId: null,
    origin: "remote",
    shell: "zsh",
  })
  const { result } = renderHook(() =>
    useTerminalHostLabel(useTerminalStore.getState().sessions["s-1"])
  )
  expect(result.current).toMatchObject({ label: "unknown", different: true })
})

it("keeps the single paired endpoint current when there is no desktop host registry target", () => {
  useTerminalStore.getState().registerSession({
    id: "s-1",
    projectId: null,
    extensionId: null,
    origin: "remote",
    shell: "zsh",
    remoteHost: { id: null, label: "https://paired.example" },
  })
  const { result } = renderHook(() =>
    useTerminalHostLabel(useTerminalStore.getState().sessions["s-1"])
  )
  expect(result.current).toMatchObject({ label: "https://paired.example", different: false })
})

it("labels a desktop-owned session spawned by a paired device as this desktop", () => {
  useTerminalStore.getState().registerSession({
    id: "s-1",
    projectId: null,
    extensionId: null,
    origin: "remote",
    shell: "zsh",
    remoteHost: null,
  })
  const { result } = renderHook(() =>
    useTerminalHostLabel(useTerminalStore.getState().sessions["s-1"])
  )
  expect(result.current).toMatchObject({ label: "thisDesktop", different: false })
})
