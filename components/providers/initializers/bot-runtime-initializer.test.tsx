/** @jest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react"

const startBotDeliveryRunner = jest.fn()
const getLocalAccountId = jest.fn(async () => "tauri:acct_1")
const markBotRunnerOwned = jest.fn(() => jest.fn())
const recoverStaleBotDeliveries = jest.fn(async () => 0)
const hasCapability = jest.fn(() => true)
const acquireExclusiveWebLock = jest.fn(async () => true)

let remoteActive = false
let remoteListener: ((remote: unknown) => void) | undefined

jest.mock("@/lib/bot/runtime/delivery-runner", () => ({
  startBotDeliveryRunner: (...args: unknown[]) => startBotDeliveryRunner(...args),
}))
jest.mock("@/lib/bot/runtime/runner-owner", () => ({
  getLocalAccountId: () => getLocalAccountId(),
  markBotRunnerOwned: () => markBotRunnerOwned(),
}))
jest.mock("@/lib/db/bot-event-deliveries", () => ({
  recoverStaleBotDeliveries: (...args: unknown[]) => recoverStaleBotDeliveries(...args),
}))
jest.mock("@/lib/platform/capabilities", () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
}))
jest.mock("@/lib/runtime/exclusive-web-lock", () => ({
  acquireExclusiveWebLock: (...args: unknown[]) => acquireExclusiveWebLock(...args),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => remoteActive,
  subscribeActiveRemoteTransport: (listener: (remote: unknown) => void) => {
    remoteListener = listener
    return () => {
      remoteListener = undefined
    }
  },
}))

import { BotRuntimeInitializer } from "./bot-runtime-initializer"

beforeEach(() => {
  startBotDeliveryRunner.mockReset().mockReturnValue({ stop: jest.fn() })
  getLocalAccountId.mockReset().mockResolvedValue("tauri:acct_1")
  markBotRunnerOwned.mockReset().mockReturnValue(jest.fn())
  recoverStaleBotDeliveries.mockReset().mockResolvedValue(0)
  hasCapability.mockReset().mockReturnValue(true)
  acquireExclusiveWebLock.mockReset().mockResolvedValue(true)
  remoteActive = false
  remoteListener = undefined
})

describe("BotRuntimeInitializer", () => {
  it("starts the runner with this shell's lease owner", async () => {
    render(<BotRuntimeInitializer />)

    await waitFor(() =>
      expect(startBotDeliveryRunner).toHaveBeenCalledWith({ owner: "tauri:acct_1" })
    )
    expect(hasCapability).toHaveBeenCalledWith("always-on")
  })

  it("reclaims the rows this host abandoned before it starts draining", async () => {
    render(<BotRuntimeInitializer />)

    await waitFor(() => expect(startBotDeliveryRunner).toHaveBeenCalled())
    expect(recoverStaleBotDeliveries).toHaveBeenCalledWith({ owner: "tauri:acct_1" })
  })

  it("does not run on a shell without always-on, so a phone never drains", async () => {
    hasCapability.mockReturnValue(false)
    render(<BotRuntimeInitializer />)

    await Promise.resolve()
    expect(startBotDeliveryRunner).not.toHaveBeenCalled()
  })

  it("does not run while this desktop is driving a remote host", async () => {
    // `always-on` is a static baseline, so a desktop acting as a companion
    // still reports it. Only the second gate catches that.
    remoteActive = true
    render(<BotRuntimeInitializer />)

    await Promise.resolve()
    expect(startBotDeliveryRunner).not.toHaveBeenCalled()
  })

  it("stops a running runner when a remote host becomes active after boot", async () => {
    const stop = jest.fn()
    startBotDeliveryRunner.mockReturnValue({ stop })
    render(<BotRuntimeInitializer />)
    await waitFor(() => expect(startBotDeliveryRunner).toHaveBeenCalled())

    act(() => remoteListener?.({}))
    await waitFor(() => expect(stop).toHaveBeenCalled())
  })

  it("yields to the webview that already holds the lock", async () => {
    acquireExclusiveWebLock.mockResolvedValue(false)
    render(<BotRuntimeInitializer />)

    await Promise.resolve()
    await Promise.resolve()
    expect(startBotDeliveryRunner).not.toHaveBeenCalled()
  })

  it("stops the runner and releases ownership on unmount", async () => {
    const stop = jest.fn()
    const release = jest.fn()
    startBotDeliveryRunner.mockReturnValue({ stop })
    markBotRunnerOwned.mockReturnValue(release)
    const view = render(<BotRuntimeInitializer />)
    await waitFor(() => expect(startBotDeliveryRunner).toHaveBeenCalled())

    view.unmount()
    expect(stop).toHaveBeenCalled()
    expect(release).toHaveBeenCalled()
  })

  it("does not start a runner for a component that unmounted while resolving", async () => {
    let resolveOwner: (value: string) => void = () => undefined
    getLocalAccountId.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveOwner = resolve
      })
    )
    const view = render(<BotRuntimeInitializer />)
    view.unmount()
    resolveOwner("tauri:acct_1")

    await Promise.resolve()
    expect(startBotDeliveryRunner).not.toHaveBeenCalled()
  })

  it("still lets the shell boot when the runner cannot start", async () => {
    startBotDeliveryRunner.mockImplementation(() => {
      throw new Error("no database")
    })
    expect(() => render(<BotRuntimeInitializer />)).not.toThrow()
    await waitFor(() => expect(startBotDeliveryRunner).toHaveBeenCalled())
  })
})
