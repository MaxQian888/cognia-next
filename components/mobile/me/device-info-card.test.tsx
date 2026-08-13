/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }))

import { DeviceInfoCard } from "./device-info-card"
import type { DeviceDetails } from "@/lib/capacitor/device"
import { NOTIFICATION_PERMISSION_GRANTED_EVENT } from "@/lib/capacitor/local-notifications"

const fullDevice: DeviceDetails = {
  model: "Pixel 8",
  platform: "android",
  operatingSystem: "android",
  osVersion: "14",
  manufacturer: "Google",
  isVirtual: false,
  webViewVersion: "120.0",
  memUsed: 256_000_000,
  realDiskFree: 10_000_000_000,
  realDiskTotal: 64_000_000_000,
  batteryLevel: 0.82,
  isCharging: true,
  languageCode: "en",
}

describe("<DeviceInfoCard />", () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it("renders detailed device fields, permissions and about cards", async () => {
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.2.3", build: "456" })}
        deviceInfoLoader={async () => fullDevice}
        permissionsLoader={async () => ({
          biometric: "available",
          biometryType: "FACE_ID",
          localNotifications: "granted",
        })}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("device-info-card")).toHaveTextContent(/1\.2\.3/)
    })
    expect(screen.getByText(/\(456\)/)).toBeInTheDocument()
    expect(screen.getByText("Pixel 8")).toBeInTheDocument()
    expect(screen.getByText("Google")).toBeInTheDocument()
    expect(screen.getByText(/android 14/)).toBeInTheDocument()
    expect(screen.getByText(/82% · charging/)).toBeInTheDocument()
    expect(screen.getByTestId("device-row-biometric")).toBeInTheDocument()
    expect(screen.getByTestId("device-row-local")).toBeInTheDocument()
    expect(screen.getByText("FACE_ID")).toBeInTheDocument()
  })

  it("falls back to APP_VERSION and omits device rows when the device loader returns null", async () => {
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "9.9.9", build: null })}
        deviceInfoLoader={async () => null}
        permissionsLoader={async () => ({
          biometric: "unsupported",
          localNotifications: "unsupported",
        })}
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/9\.9\.9/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/null/)).toBeNull()
    expect(screen.queryByText("Pixel 8")).toBeNull()
  })

  it("shows the enroll hint and a settings button when biometric is unavailable", async () => {
    const settingsOpener = jest.fn(async () => ({ kind: "ok" as const }))
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.0.0", build: null })}
        deviceInfoLoader={async () => null}
        permissionsLoader={async () => ({
          biometric: "unavailable",
          localNotifications: "granted",
        })}
        settingsOpener={settingsOpener}
      />
    )
    const btn = await screen.findByTestId("device-biometric-settings")
    await userEvent.click(btn)
    expect(settingsOpener).toHaveBeenCalledTimes(1)
  })

  it("requests notification permission and refreshes status on Enable", async () => {
    const requester = jest.fn(async () => ({ kind: "ok" as const, value: "granted" as const }))
    const permissionsLoader = jest
      .fn()
      .mockResolvedValueOnce({ biometric: "unsupported", localNotifications: "prompt" })
      .mockResolvedValueOnce({ biometric: "unsupported", localNotifications: "granted" })
    const onGranted = jest.fn()
    window.addEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.0.0", build: null })}
        deviceInfoLoader={async () => null}
        permissionsLoader={permissionsLoader}
        requester={requester}
      />
    )
    const enable = await screen.findByTestId("device-local-enable")
    await userEvent.click(enable)
    await waitFor(() => expect(requester).toHaveBeenCalledTimes(1))
    expect(permissionsLoader).toHaveBeenCalledTimes(2)
    expect(onGranted).toHaveBeenCalledTimes(1)
    window.removeEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
  })

  it("opens settings when notifications are denied", async () => {
    const settingsOpener = jest.fn(async () => ({ kind: "ok" as const }))
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.0.0", build: null })}
        deviceInfoLoader={async () => null}
        permissionsLoader={async () => ({ biometric: "unsupported", localNotifications: "denied" })}
        settingsOpener={settingsOpener}
      />
    )
    const btn = await screen.findByTestId("device-local-settings")
    await userEvent.click(btn)
    expect(settingsOpener).toHaveBeenCalledTimes(1)
  })

  it("runs a biometric test and toasts success", async () => {
    const verifier = jest.fn(async () => ({ kind: "verified" as const }))
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.0.0", build: null })}
        deviceInfoLoader={async () => null}
        permissionsLoader={async () => ({
          biometric: "available",
          biometryType: "TOUCH_ID",
          localNotifications: "granted",
        })}
        verifier={verifier}
      />
    )
    const btn = await screen.findByTestId("device-biometric-test")
    await userEvent.click(btn)
    await waitFor(() => expect(verifier).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it("toasts failure when the biometric test is not verified", async () => {
    const verifier = jest.fn(async () => ({ kind: "lockout" as const }))
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.0.0", build: null })}
        deviceInfoLoader={async () => null}
        permissionsLoader={async () => ({
          biometric: "available",
          localNotifications: "granted",
        })}
        verifier={verifier}
      />
    )
    const btn = await screen.findByTestId("device-biometric-test")
    await userEvent.click(btn)
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
