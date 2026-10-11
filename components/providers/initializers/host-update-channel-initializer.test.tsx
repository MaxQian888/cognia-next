/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"

const hasCapabilityMock = jest.fn(() => true)
jest.mock("@/lib/platform/capabilities", () => ({
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...(args as [])),
}))

import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

import {
  HOST_CHANNEL_PUSH_DELAY_MS,
  HostUpdateChannelInitializer,
} from "./host-update-channel-initializer"

function setHosts(hosts: Array<{ id: string; alwaysOn?: boolean; connectionState?: string }>) {
  useRemoteHostStore.setState({
    hosts: hosts.map((host) => ({
      label: host.id,
      connectionState: "disconnected",
      ...host,
    })),
  } as never)
}

function setChannel(channel: "stable" | "beta", loaded = true) {
  useSettingsStore.setState({
    loaded,
    settings: { ...(useSettingsStore.getState().settings ?? {}), updateCenter: { channel } },
  } as never)
}

beforeEach(() => {
  jest.useFakeTimers()
  hasCapabilityMock.mockReturnValue(true)
  setHosts([])
  setChannel("stable")
})
afterEach(() => jest.useRealTimers())

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(HOST_CHANNEL_PUSH_DELAY_MS)
  })
}

it("pushes the channel to always-on hosts once things settle, and again on change", async () => {
  setHosts([
    { id: "mini", alwaysOn: true },
    { id: "laptop" },
    { id: "gone", alwaysOn: true, connectionState: "revoked" },
  ])
  const push = jest.fn(async () => [])
  render(<HostUpdateChannelInitializer push={push} />)
  await settle()
  expect(push).toHaveBeenCalledWith("stable", ["mini"])

  act(() => setChannel("beta"))
  await settle()
  expect(push).toHaveBeenLastCalledWith("beta", ["mini"])

  // A newly paired host is pushed to.
  act(() =>
    setHosts([
      { id: "mini", alwaysOn: true },
      { id: "nas", alwaysOn: true },
    ])
  )
  await settle()
  expect(push).toHaveBeenLastCalledWith("beta", ["mini", "nas"])
  expect(push).toHaveBeenCalledTimes(3)
})

it("waits for settings to load, and does nothing without hosts or off the desktop", async () => {
  setChannel("beta", false)
  setHosts([{ id: "mini", alwaysOn: true }])
  const push = jest.fn(async () => [])
  const { unmount } = render(<HostUpdateChannelInitializer push={push} />)
  await settle()
  expect(push).not.toHaveBeenCalled()
  act(() => setChannel("beta", true))
  await settle()
  expect(push).toHaveBeenCalledWith("beta", ["mini"])
  unmount()

  push.mockClear()
  hasCapabilityMock.mockReturnValue(false)
  render(<HostUpdateChannelInitializer push={push} />)
  await settle()
  expect(push).not.toHaveBeenCalled()
})
