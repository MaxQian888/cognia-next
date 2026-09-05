import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { PushCredentialsBlock } from "./push-credentials-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
let status = { fcmConfigured: false, apnsConfigured: false }
const call = jest.fn(async (name: string) => {
  if (name === "companion_push_status") return status
  if (name === "companion_push_configure_fcm") status = { ...status, fcmConfigured: true }
  return undefined
})
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...(a as [string])) },
}))

describe("PushCredentialsBlock", () => {
  beforeEach(() => {
    reach.mockReturnValue({ available: true })
    status = { fcmConfigured: false, apnsConfigured: false }
    call.mockClear()
  })

  it("saves the FCM service account over the host-admin plane and reports the new status", async () => {
    const onStatus = jest.fn()
    render(<PushCredentialsBlock onStatus={onStatus} />)
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith({ fcmConfigured: false, apnsConfigured: false })
    )
    fireEvent.change(screen.getByLabelText("fcmAria"), { target: { value: '{"type":"sa"}' } })
    await act(async () => {
      fireEvent.click(screen.getByText("saveFcm"))
    })
    expect(call).toHaveBeenCalledWith("companion_push_configure_fcm", {
      serviceAccountJson: '{"type":"sa"}',
    })
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({ fcmConfigured: true, apnsConfigured: false })
    )
  })

  it("renders the form disabled with the reason when nothing can be configured from here", () => {
    reach.mockReturnValue({ available: false, block: "no-host" })
    render(<PushCredentialsBlock />)
    expect(screen.getByLabelText("fcmAria")).toBeDisabled()
    expect(screen.getByTestId("push-reach")).toHaveAttribute("data-reach", "no-host")
    expect(call).not.toHaveBeenCalled()
  })
})
