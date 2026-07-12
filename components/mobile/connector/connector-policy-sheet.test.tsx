/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConnectorPolicySheet, type ConnectorPolicy } from "./connector-policy-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: `Settings for ${vars?.name ?? ""}`,
      description: "Choose how this conversation handles incoming messages.",
      defaultMode: "Default mode",
      defaultModeHelp: "help",
      modeAuto: "Auto",
      modeDraft: "Draft",
      modeManual: "Manual",
      muted: "Mute this conversation",
      mutedHelp: "help",
      quietHours: "Quiet hours",
      quietHoursHelp: "help",
      from: "From",
      to: "To",
      save: "Save",
      saving: "Saving…",
      saved: "Settings saved.",
      saveFailed: `Save failed: ${vars?.message ?? ""}`,
      queueLabel: `Queued for ${vars?.name ?? ""}`,
    }
    return map[key] ?? key
  },
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

const updateMock = jest.fn(async (..._a: unknown[]) => 1)
const modifyMock = jest.fn(async (..._a: unknown[]) => 1)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    adapterInstances: {
      update: (...a: unknown[]) => updateMock(...a),
      where: () => ({ equals: () => ({ modify: (...a: unknown[]) => modifyMock(...a) }) }),
    },
  }),
}))

const enqueueMock = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...a: unknown[]) => enqueueMock(...a),
}))

function makePolicy(overrides: Partial<ConnectorPolicy> = {}): ConnectorPolicy {
  return {
    id: "ad-1",
    displayName: "Team Telegram",
    defaultMode: "auto",
    muted: false,
    ...overrides,
  }
}

beforeEach(() => {
  updateMock.mockClear()
  modifyMock.mockClear()
  enqueueMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<ConnectorPolicySheet />", () => {
  it("renders nothing without a policy", () => {
    const { container } = render(
      <ConnectorPolicySheet open policy={null} onOpenChange={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("saves without quiet hours: Dexie update, quietHours cleared, RPC enqueued with null", async () => {
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={onOpenChange} />)

    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        "ad-1",
        expect.objectContaining({ defaultMode: "auto", muted: false })
      )
    )
    // No quiet window → the row's stale quietHours is dropped via modify.
    expect(modifyMock).toHaveBeenCalled()
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "adapter_update_policy",
        payload: expect.objectContaining({ id: "ad-1", quietHours: null }),
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith("Settings saved.")
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("saves a full quiet-hours window when both bounds are set", async () => {
    const user = userEvent.setup()
    render(
      <ConnectorPolicySheet
        open
        policy={makePolicy({ muted: true })}
        onOpenChange={jest.fn()}
      />
    )

    fireEvent.change(screen.getByTestId("policy-quiet-from"), { target: { value: "22:00" } })
    fireEvent.change(screen.getByTestId("policy-quiet-to"), { target: { value: "07:00" } })
    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        "ad-1",
        expect.objectContaining({
          muted: true,
          quietHours: expect.objectContaining({ from: "22:00", to: "07:00" }),
        })
      )
    )
    expect(modifyMock).not.toHaveBeenCalled()
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          quietHours: expect.objectContaining({ from: "22:00", to: "07:00" }),
        }),
      })
    )
  })

  it("re-seeds the form when the sheet opens for a different adapter", async () => {
    const { rerender } = render(
      <ConnectorPolicySheet open policy={makePolicy()} onOpenChange={jest.fn()} />
    )
    rerender(
      <ConnectorPolicySheet
        open
        policy={makePolicy({
          id: "ad-2",
          displayName: "Support Discord",
          quietHours: { from: "21:00", to: "08:00", tz: "UTC" },
        })}
        onOpenChange={jest.fn()}
      />
    )
    expect(screen.getByText("Settings for Support Discord")).toBeInTheDocument()
    expect((screen.getByTestId("policy-quiet-from") as HTMLInputElement).value).toBe("21:00")
    expect((screen.getByTestId("policy-quiet-to") as HTMLInputElement).value).toBe("08:00")
  })

  it("surfaces a save failure as an error toast and keeps the sheet open", async () => {
    updateMock.mockRejectedValueOnce(new Error("boom"))
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={onOpenChange} />)

    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Save failed: boom"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
