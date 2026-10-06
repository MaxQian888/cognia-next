import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"

import { PushCredentialsBlock, type PushConfigStatus } from "./push-credentials-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

const reach = jest.fn<HostAdminReach, [string]>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: (command: string) => reach(command),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
let status: PushConfigStatus = { fcmConfigured: false, apnsConfigured: false }
const defaultCall = async (name: string) => {
  if (name === "companion_push_status") return status
  if (name === "companion_push_configure_fcm") status = { ...status, fcmConfigured: true }
  if (name === "companion_push_configure_hms") status = { ...status, hmsConfigured: true }
  if (name === "companion_push_clear_hms") status = { ...status, hmsConfigured: false }
  return undefined
}
const call = jest.fn(defaultCall)
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...(a as [string])) },
}))

describe("PushCredentialsBlock", () => {
  beforeEach(() => {
    reach.mockReturnValue({ available: true })
    status = { fcmConfigured: false, apnsConfigured: false }
    call.mockReset().mockImplementation(defaultCall)
    jest.mocked(toast.success).mockClear()
    jest.mocked(toast.error).mockClear()
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

  it("keeps HMS disabled when an older host omits HMS support", async () => {
    const onStatus = jest.fn()
    render(<PushCredentialsBlock onStatus={onStatus} />)
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(status))
    expect(screen.getByRole("button", { name: "saveHms" })).toBeDisabled()
    expect(screen.getByText("hmsUnsupported")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "saveFcm" })).toBeEnabled()
  })

  it("recovers Huawei configuration after a failed initial status request is retried", async () => {
    status = { ...status, hmsConfigured: false }
    let resolveRetry!: (value: PushConfigStatus) => void
    call.mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(
      () =>
        new Promise<PushConfigStatus>((resolve) => {
          resolveRetry = resolve
        })
    )
    const onStatus = jest.fn()
    render(<PushCredentialsBlock onStatus={onStatus} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("statusLoadFailed")
    expect(screen.getByRole("button", { name: "saveHms" })).toBeDisabled()
    const retry = screen.getByRole("button", { name: "statusRetry" })
    fireEvent.click(retry)
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(call).toHaveBeenCalledTimes(2)
    await act(async () => resolveRetry(status))
    expect(onStatus).toHaveBeenCalledWith(status)
    expect(screen.getByRole("button", { name: "saveHms" })).toBeEnabled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "statusRetry" })).not.toBeInTheDocument()
  })

  it("requires both Huawei credentials before saving", async () => {
    status = { ...status, hmsConfigured: false }
    render(<PushCredentialsBlock />)
    await waitFor(() => expect(screen.getByRole("button", { name: "saveHms" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "saveHms" }))
    expect(toast.error).toHaveBeenCalledWith("hmsAppIdRequired")
    fireEvent.change(screen.getByLabelText("hmsAppId"), { target: { value: "123456" } })
    fireEvent.click(screen.getByRole("button", { name: "saveHms" }))
    expect(toast.error).toHaveBeenCalledWith("hmsClientSecretRequired")
    expect(call.mock.calls.every(([name]) => name === "companion_push_status")).toBe(true)
  })

  it("saves Huawei credentials, clears the secret, reports status and clears the configuration", async () => {
    status = { ...status, hmsConfigured: false }
    const onStatus = jest.fn()
    render(<PushCredentialsBlock onStatus={onStatus} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "saveHms" })).toBeEnabled())
    const secret = screen.getByLabelText("hmsClientSecret")
    expect(secret).toHaveAttribute("type", "password")
    fireEvent.change(screen.getByLabelText("hmsAppId"), { target: { value: " 123456 " } })
    fireEvent.change(secret, { target: { value: " secret " } })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "saveHms" })))
    expect(call).toHaveBeenCalledWith("companion_push_configure_hms", {
      appId: "123456",
      clientSecret: "secret",
    })
    expect(secret).toHaveValue("")
    expect(toast.success).toHaveBeenCalledWith("hmsConfigured")
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ hmsConfigured: true }))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "clearHms" })))
    expect(call).toHaveBeenCalledWith("companion_push_clear_hms")
    expect(toast.success).toHaveBeenCalledWith("hmsCleared")
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ hmsConfigured: false }))
  })

  it("reports failed Huawei saves and retains the secret so the user can retry", async () => {
    status = { ...status, hmsConfigured: false }
    call.mockImplementation(async (name) => {
      if (name === "companion_push_configure_hms") throw new Error("rejected")
      return defaultCall(name)
    })
    render(<PushCredentialsBlock />)
    await waitFor(() => expect(screen.getByRole("button", { name: "saveHms" })).toBeEnabled())
    fireEvent.change(screen.getByLabelText("hmsAppId"), { target: { value: "123456" } })
    fireEvent.change(screen.getByLabelText("hmsClientSecret"), { target: { value: "secret" } })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "saveHms" })))
    expect(toast.error).toHaveBeenCalledWith("hmsConfigureFailed")
    expect(screen.getByLabelText("hmsClientSecret")).toHaveValue("secret")
    expect(screen.getByRole("button", { name: "saveHms" })).toBeEnabled()
  })

  it("reports failed Huawei clears without losing the configured state", async () => {
    status = { ...status, hmsConfigured: true }
    call.mockImplementation(async (name) => {
      if (name === "companion_push_clear_hms") throw new Error("rejected")
      return defaultCall(name)
    })
    render(<PushCredentialsBlock />)
    await screen.findByRole("button", { name: "clearHms" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "clearHms" })))
    expect(toast.error).toHaveBeenCalledWith("hmsClearFailed")
    expect(screen.getByRole("button", { name: "clearHms" })).toBeEnabled()
  })

  it("checks Huawei save and clear command reach independently of FCM", async () => {
    status = { ...status, hmsConfigured: true }
    reach.mockImplementation((command) => ({
      available: !["companion_push_configure_hms", "companion_push_clear_hms"].includes(command),
    }))
    render(<PushCredentialsBlock />)
    await screen.findByRole("button", { name: "clearHms" })
    expect(screen.getByRole("button", { name: "saveHms" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "clearHms" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "saveFcm" })).toBeEnabled()
  })
})
