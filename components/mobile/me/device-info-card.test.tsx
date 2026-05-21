/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/capacitor/biometric", () => ({
  isAvailable: jest.fn(async () => ({
    kind: "ok" as const,
    value: { available: true, biometryType: "FACE_ID" },
  })),
}))
jest.mock("@/lib/capacitor/local-notifications", () => ({
  checkPermission: jest.fn(async () => ({
    kind: "ok" as const,
    value: "granted" as const,
  })),
}))

import { DeviceInfoCard } from "./device-info-card"

describe("<DeviceInfoCard />", () => {
  it("renders the hardware, permissions and about cards", async () => {
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.2.3", build: "456" })}
        permissionsLoader={async () => ({
          biometric: "granted",
          biometryType: "FACE_ID",
          localNotifications: "granted",
        })}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("device-info-card")).toHaveTextContent(/1\.2\.3/)
    })
    expect(screen.getByText(/\(456\)/)).toBeInTheDocument()
    expect(screen.getByTestId("device-row-biometric")).toBeInTheDocument()
    expect(screen.getByTestId("device-row-local")).toBeInTheDocument()
  })

  it("falls back to APP_VERSION when the app info loader does not provide a build", async () => {
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "9.9.9", build: null })}
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
  })

  it("reports unsupported permission status when the loader returns it", async () => {
    render(
      <DeviceInfoCard
        appInfoLoader={async () => ({ version: "1.0.0", build: null })}
        permissionsLoader={async () => ({
          biometric: "unsupported",
          localNotifications: "denied",
        })}
      />
    )
    await waitFor(() => {
      const text = screen.getByTestId("device-row-biometric").textContent ?? ""
      expect(text).toMatch(/unsupported/i)
    })
    await waitFor(() => {
      const text = screen.getByTestId("device-row-local").textContent ?? ""
      expect(text).toMatch(/denied/i)
    })
  })
})
