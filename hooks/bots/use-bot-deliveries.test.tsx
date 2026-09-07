/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

let liveDeps: unknown[] = []
let liveValue: unknown
let lastRead: (() => unknown) | undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (read: () => unknown, deps: unknown[]) => {
    liveDeps = deps
    lastRead = read
    return liveValue
  },
}))

const listBotDeliveries = jest.fn(async () => [])
jest.mock("@/lib/db/bot-event-deliveries", () => ({
  listBotDeliveries: (...args: unknown[]) => listBotDeliveries(...(args as [])),
}))

import { BOT_DELIVERY_PAGE_SIZE, useBotDeliveries } from "./use-bot-deliveries"

beforeEach(() => {
  liveValue = undefined
  liveDeps = []
  lastRead = undefined
  listBotDeliveries.mockClear().mockResolvedValue([])
})

describe("useBotDeliveries", () => {
  it("reads a capped page for the selected installation", async () => {
    renderHook(() => useBotDeliveries("boti_1"))
    await lastRead?.()
    expect(listBotDeliveries).toHaveBeenCalledWith({
      installationId: "boti_1",
      limit: BOT_DELIVERY_PAGE_SIZE,
    })
    expect(liveDeps).toEqual(["boti_1"])
  })

  it("reads nothing when no Bot is selected", async () => {
    renderHook(() => useBotDeliveries(null))
    expect(await lastRead?.()).toEqual([])
    expect(listBotDeliveries).not.toHaveBeenCalled()
  })

  it("reports loading until the first read resolves, distinctly from empty", () => {
    const { result, rerender } = renderHook(() => useBotDeliveries("boti_1"))
    expect(result.current).toEqual({ rows: [], loading: true })

    liveValue = []
    rerender()
    expect(result.current).toEqual({ rows: [], loading: false })
  })
})
