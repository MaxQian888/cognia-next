jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))

import { act, fireEvent, render, screen, within } from "@testing-library/react"

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { createStatusFixture } from "@/lib/status/fixtures"
import type { StatusCapabilities, StatusRuntime } from "@/lib/status/public-status"

import { SubscriptionDialog } from "./subscription-dialog"

const primary: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}
const capabilities: StatusCapabilities = createStatusFixture("operational").capabilities
const fetchMock = jest.fn()

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
})

function renderDialog(runtime = primary, caps: StatusCapabilities | null = capabilities) {
  const onOpenChange = jest.fn()
  render(
    <SubscriptionDialog open onOpenChange={onOpenChange} runtime={runtime} capabilities={caps} />
  )
  return {
    onOpenChange,
    dialog: screen.getByRole("dialog", { name: "Subscribe to status updates" }),
  }
}

describe("SubscriptionDialog", () => {
  it("submits address, language and scope, then says a confirmation may have been sent", async () => {
    fetchMock.mockResolvedValue(respond(202, { status: "accepted" }))
    const { dialog } = renderDialog()
    expect(dialog).toHaveTextContent("You get no status emails until you confirm.")
    fireEvent.change(within(dialog).getByLabelText("Email address"), {
      target: { value: "ops@example.com" },
    })
    fireEvent.change(within(dialog).getByLabelText("Email language"), {
      target: { value: "zh-CN" },
    })
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Relay data lane" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    expect(within(dialog).getByRole("status")).toHaveTextContent("Sending…")
    await flush()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      email: "ops@example.com",
      locale: "zh-CN",
      componentIds: ["relayData"],
    })
    const pending = within(dialog).getByTestId("subscription-pending")
    expect(pending).toHaveAttribute("role", "status")
    expect(pending).toHaveTextContent("Check your inbox")
    expect(pending).toHaveTextContent("If this address can be subscribed")
    expect(dialog).not.toHaveTextContent(/you are subscribed/i)
  })

  it("sends an empty scope for every component", async () => {
    fetchMock.mockResolvedValue(respond(202, { status: "accepted" }))
    const { dialog } = renderDialog()
    fireEvent.change(within(dialog).getByLabelText("Email address"), {
      target: { value: "ops@example.com" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    await flush()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).componentIds).toEqual([])
  })

  it("rejects an obviously invalid address without posting", () => {
    const { dialog } = renderDialog()
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "nope" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a valid email address.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [429, "rate_limited", "Too many requests."],
    [503, "unavailable", "temporarily unavailable"],
    [403, "forbidden", "This request was refused."],
  ])("announces HTTP %s (%s)", async (status, code, text) => {
    fetchMock.mockResolvedValue(respond(status, { code, requestId: "r" }))
    const { dialog } = renderDialog()
    fireEvent.change(within(dialog).getByLabelText("Email address"), {
      target: { value: "ops@example.com" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    await flush()
    const alert = within(dialog).getByTestId("subscription-error")
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toHaveTextContent(text)
  })

  it("announces a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"))
    const { dialog } = renderDialog()
    fireEvent.change(within(dialog).getByLabelText("Email address"), {
      target: { value: "ops@example.com" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    await flush()
    expect(within(dialog).getByTestId("subscription-error")).toHaveTextContent(
      "could not reach the status service"
    )
  })

  it("is disabled with an explanation when email is not available", () => {
    const { dialog } = renderDialog(primary, { ...capabilities, email: false })
    expect(within(dialog).getByTestId("subscription-disabled")).toHaveTextContent(
      "Email subscriptions are not available right now."
    )
    expect(within(dialog).queryByLabelText("Email address")).toBeNull()
  })

  it("does not offer signup on a mirror and links to the primary page", () => {
    const { dialog } = renderDialog({ ...primary, mode: "mirror", allowsConsentWrites: false })
    expect(within(dialog).queryByLabelText("Email address")).toBeNull()
    expect(
      within(dialog).getByRole("link", { name: "Subscribe on the primary page" })
    ).toHaveAttribute("href", "https://status.cognia.cn/status/")
  })

  it("closes from its own button", () => {
    const { dialog, onOpenChange } = renderDialog()
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
