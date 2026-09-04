/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react"

const startBotDeliveryRunner = jest.fn()
const getLocalAccountId = jest.fn(async () => "tauri:acct_1")

jest.mock("@/lib/bot/runtime/delivery-runner", () => ({
  startBotDeliveryRunner: (...args: unknown[]) => startBotDeliveryRunner(...args),
}))
jest.mock("@/lib/bot/runtime/runner-owner", () => ({
  getLocalAccountId: () => getLocalAccountId(),
}))

import { BotRuntimeInitializer } from "./bot-runtime-initializer"

beforeEach(() => {
  startBotDeliveryRunner.mockReset()
  getLocalAccountId.mockReset().mockResolvedValue("tauri:acct_1")
})

describe("BotRuntimeInitializer", () => {
  it("starts the runner with this shell's lease owner", async () => {
    startBotDeliveryRunner.mockReturnValue({ stop: jest.fn() })
    render(<BotRuntimeInitializer />)

    await waitFor(() =>
      expect(startBotDeliveryRunner).toHaveBeenCalledWith({ owner: "tauri:acct_1" })
    )
  })

  it("stops the runner on unmount", async () => {
    const stop = jest.fn()
    startBotDeliveryRunner.mockReturnValue({ stop })
    const view = render(<BotRuntimeInitializer />)
    await waitFor(() => expect(startBotDeliveryRunner).toHaveBeenCalled())

    view.unmount()
    expect(stop).toHaveBeenCalled()
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
    // Deliveries stay queued, and another Host or the next boot drains them.
    expect(() => render(<BotRuntimeInitializer />)).not.toThrow()
    await waitFor(() => expect(startBotDeliveryRunner).toHaveBeenCalled())
  })
})
