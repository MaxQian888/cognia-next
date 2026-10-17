import { render, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import {
  BestOfNRecoveryInitializer,
  __resetBestOfNRecoveryForTests,
} from "./best-of-n-recovery-initializer"

const recover = jest.fn()
const warn = jest.fn()
jest.mock("@/lib/best-of-n/restart-recovery", () => ({
  recoverBestOfNRunsOnStartup: () => recover(),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { agent: { warn: (...a: unknown[]) => warn(...a) } },
}))

beforeEach(() => {
  __resetBestOfNRecoveryForTests()
  recover.mockReset()
  warn.mockReset()
})

it("recovers once per process, even under StrictMode remounts", async () => {
  recover.mockResolvedValue({ recovered: [], released: [], failed: [] })
  const view = render(
    <StrictMode>
      <BestOfNRecoveryInitializer />
    </StrictMode>
  )
  view.rerender(
    <StrictMode>
      <BestOfNRecoveryInitializer />
    </StrictMode>
  )
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(1))
  expect(warn).not.toHaveBeenCalled()
})

it("logs groups it could not recover and a failed pass", async () => {
  recover.mockResolvedValueOnce({
    recovered: [],
    released: [],
    failed: [{ groupId: "g", error: "x" }],
  })
  render(<BestOfNRecoveryInitializer />)
  await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
  __resetBestOfNRecoveryForTests()
  recover.mockRejectedValueOnce(new Error("Host offline"))
  render(<BestOfNRecoveryInitializer />)
  await waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
  expect(String(warn.mock.calls[1][1].error)).toContain("Host offline")
})
