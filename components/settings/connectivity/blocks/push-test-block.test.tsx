import { act, fireEvent, render, screen } from "@testing-library/react"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

import { PUSH_TEST_HREF, PushTestBlock } from "./push-test-block"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.count !== undefined ? `${key}:${String(values.count)}` : key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

describe("PushTestBlock", () => {
  beforeEach(() => reach.mockReturnValue({ available: true }))

  it("sends a metadata-only system notification and reports the fan-out count", async () => {
    const send = jest.fn(async () => ({ sent: 2 }))
    render(<PushTestBlock configured send={send} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("push-test-send"))
    })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ source: "system", level: "info", href: PUSH_TEST_HREF })
    )
    expect(screen.getByTestId("push-test-result")).toHaveTextContent("testResult:2")
  })

  it("disables the button until a provider is configured, with the reason", () => {
    render(<PushTestBlock configured={false} />)
    expect(screen.getByTestId("push-test-send")).toBeDisabled()
    expect(screen.getByTestId("push-test-unconfigured")).toBeInTheDocument()
  })

  it("explains a block instead of hiding the control", () => {
    reach.mockReturnValue({ available: false, block: "no-host" })
    render(<PushTestBlock configured />)
    expect(screen.getByTestId("push-test-send")).toBeDisabled()
    expect(screen.getByTestId("push-test-reach")).toHaveAttribute("data-reach", "no-host")
  })
})
