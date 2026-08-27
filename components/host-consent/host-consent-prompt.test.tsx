/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockList = jest.fn()
const mockRespond = jest.fn()
const mockSubscribe = jest.fn()

jest.mock("@/lib/host-consent/client", () => ({
  listPendingHostConsent: () => mockList(),
  respondToHostConsent: (...args: unknown[]) => mockRespond(...args),
  subscribeToHostConsent: (handler: () => void) => mockSubscribe(handler),
}))

const mockGetPairedDevice = jest.fn()
jest.mock("@/lib/db/paired-devices", () => ({
  getPairedDevice: (...args: unknown[]) => mockGetPairedDevice(...args),
}))

import { HostConsentPrompt } from "./host-consent-prompt"

const REQUEST = {
  id: "req-1",
  code: "A1B2C3D4",
  deviceId: "phone-1",
  operations: ["connectors_keyring_get", "connectors_keyring_set"],
  state: "pending" as const,
  requestedAt: 1,
  expiresAt: 2,
}

let notify: () => void = () => {}

beforeEach(() => {
  jest.clearAllMocks()
  mockList.mockResolvedValue([])
  mockRespond.mockResolvedValue({ ...REQUEST, state: "approved" })
  mockGetPairedDevice.mockResolvedValue(undefined)
  mockSubscribe.mockImplementation((handler: () => void) => {
    notify = handler
    return () => undefined
  })
})

describe("HostConsentPrompt", () => {
  it("renders nothing when there is nothing to answer", async () => {
    render(<HostConsentPrompt />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("renders nothing when this device is not an approver", async () => {
    // `host_consent_pending` refuses without host.admin. That refusal IS the
    // capability probe — a device that cannot answer must not be shown a
    // prompt it will only fail at.
    mockList.mockRejectedValue(new Error("REMOTE_SCOPE_DENIED: requires host.admin"))
    render(<HostConsentPrompt />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("names the exact operations rather than summarising them", async () => {
    mockList.mockResolvedValue([REQUEST])
    render(<HostConsentPrompt />)

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("connectors_keyring_get")).toBeInTheDocument()
    expect(screen.getByText("connectors_keyring_set")).toBeInTheDocument()
    expect(screen.getByText("A1B2C3D4")).toBeInTheDocument()
  })

  it("falls back to the device id when no paired label is stored here", async () => {
    mockList.mockResolvedValue([REQUEST])
    render(<HostConsentPrompt />)
    expect(await screen.findByText(/phone-1/)).toBeInTheDocument()
  })

  it("prefers a stored label when the approver's shell did the pairing", async () => {
    mockList.mockResolvedValue([REQUEST])
    mockGetPairedDevice.mockResolvedValue({ label: "Ada's iPhone" })
    render(<HostConsentPrompt />)
    expect(await screen.findByText(/Ada's iPhone/)).toBeInTheDocument()
  })

  it("approves by id and re-reads afterwards", async () => {
    mockList.mockResolvedValue([REQUEST])
    render(<HostConsentPrompt />)
    await screen.findByRole("dialog")
    mockList.mockResolvedValue([])

    await userEvent.click(screen.getByRole("button", { name: "Approve" }))

    expect(mockRespond).toHaveBeenCalledWith("req-1", true)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("carries a denial as explicitly as an approval", async () => {
    mockList.mockResolvedValue([REQUEST])
    render(<HostConsentPrompt />)
    await screen.findByRole("dialog")
    mockList.mockResolvedValue([])

    await userEvent.click(screen.getByRole("button", { name: "Deny" }))

    expect(mockRespond).toHaveBeenCalledWith("req-1", false)
  })

  it("says so when the host refuses the answer instead of closing silently", async () => {
    mockList.mockResolvedValue([REQUEST])
    mockRespond.mockRejectedValue(new Error("REMOTE_CONSENT_REQUIRED: no open request"))
    render(<HostConsentPrompt />)
    await screen.findByRole("dialog")

    await userEvent.click(screen.getByRole("button", { name: "Approve" }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })

  it("re-reads on a frame rather than rendering the frame", async () => {
    // The channel reaches every subscriber including the asking device; only
    // the host knows what THIS device may answer.
    render(<HostConsentPrompt />)
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))

    mockList.mockResolvedValue([REQUEST])
    await act(async () => {
      notify()
    })

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("counts the ones stacked behind the current decision", async () => {
    mockList.mockResolvedValue([REQUEST, { ...REQUEST, id: "req-2", deviceId: "phone-2" }])
    render(<HostConsentPrompt />)
    expect(await screen.findByText("1 more waiting")).toBeInTheDocument()
  })
})
