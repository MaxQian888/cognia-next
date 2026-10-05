/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/account-sync/enrollment/join", () => ({
  startJoin: jest.fn(),
  pollJoin: jest.fn(),
  completeJoin: jest.fn(),
  cancelJoin: jest.fn(),
}))
jest.mock("@/lib/account-sync/enrollment/platform", () => ({
  currentDevicePlatform: () => "web",
  suggestDeviceName: () => "Linux",
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"

import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { cancelJoin, completeJoin, pollJoin, startJoin } from "@/lib/account-sync/enrollment/join"

import { JOIN_POLL_MS, JoinRequestPanel } from "./join-request-panel"

const context = {} as AccountSyncContext
const join = { requestId: "req_1", expiresAt: Date.now() + 15 * 60_000 }

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.mocked(startJoin).mockResolvedValue(join as never)
})
afterEach(() => jest.useRealTimers())

async function start() {
  const onDone = jest.fn()
  render(<JoinRequestPanel context={context} onDone={onDone} />)
  await act(async () => fireEvent.click(screen.getByTestId("account-sync-join-start")))
  await flush()
  return onDone
}

describe("JoinRequestPanel", () => {
  it("asks, waits, shows the code, and completes on approval", async () => {
    jest
      .mocked(pollJoin)
      .mockResolvedValueOnce({ phase: "waiting" })
      .mockResolvedValueOnce({ phase: "code", code: "123 456", approverDeviceId: "dev_A" })
      .mockResolvedValue({ phase: "approved" })
    jest.mocked(completeJoin).mockResolvedValue({} as never)
    const onDone = await start()
    expect(startJoin).toHaveBeenCalledWith(context, { name: "Linux", platform: "web" })
    expect(screen.getByTestId("account-sync-join")).toHaveAttribute("data-phase", "waiting")
    await act(async () => {
      jest.advanceTimersByTime(JOIN_POLL_MS)
    })
    await flush()
    expect(screen.getByTestId("account-sync-join-code")).toHaveTextContent("123 456")
    expect(screen.getByText("join.expiresIn(15)")).toBeInTheDocument()
    await act(async () => {
      jest.advanceTimersByTime(JOIN_POLL_MS)
    })
    await flush()
    expect(completeJoin).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("join.done")
  })

  it("shows how a request ended and lets the person ask again", async () => {
    jest.mocked(pollJoin).mockResolvedValue({ phase: "ended", reason: "denied" })
    await start()
    expect(screen.getByTestId("account-sync-join-ended")).toHaveTextContent("join.ended.denied")
    fireEvent.click(screen.getByTestId("account-sync-join-again"))
    expect(screen.getByTestId("account-sync-join-start")).toBeInTheDocument()
  })

  it("cancels", async () => {
    jest.mocked(pollJoin).mockResolvedValue({ phase: "waiting" })
    jest.mocked(cancelJoin).mockResolvedValue()
    await start()
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-join-cancel")))
    expect(cancelJoin).toHaveBeenCalledWith(context, join)
    expect(screen.getByTestId("account-sync-join-ended")).toHaveTextContent("join.ended.cancelled")
  })

  it("explains a failure to start", async () => {
    jest.mocked(startJoin).mockRejectedValue(new Error("boom"))
    render(<JoinRequestPanel context={context} onDone={jest.fn()} />)
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-join-start")))
    expect(screen.getByRole("alert")).toHaveTextContent("errors.generic(boom)")
  })
})
