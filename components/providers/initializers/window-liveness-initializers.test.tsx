import { render, act } from "@testing-library/react"

import { WindowLivenessInitializers } from "./window-liveness-initializers"

// Replace every `next/dynamic(...)` call with the same lightweight stub so we
// can assert how many gated children render without pulling the real desktop
// subsystem graphs (Tauri window API, watchdog) into the test.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="liveness-child" />
  Stub.displayName = "MockLivenessChild"
  return Stub
})

const isTauriMock = jest.fn()
jest.mock("@/lib/native/utils", () => ({
  isTauri: () => isTauriMock(),
}))

let mockPetRole: "main" | "web" | "overlay" | "popup" | "island" | "selection-toolbar" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island" || role === "selection-toolbar",
}))

describe("WindowLivenessInitializers", () => {
  beforeEach(() => {
    isTauriMock.mockReset()
    mockPetRole = "main"
  })

  it("renders nothing on web (isTauri() === false)", async () => {
    isTauriMock.mockReturnValue(false)
    let container!: HTMLElement
    await act(async () => {
      container = render(<WindowLivenessInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="liveness-child"]')).toHaveLength(0)
  })

  it("renders the reveal + heartbeat once mounted on the Tauri main window", async () => {
    isTauriMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = render(<WindowLivenessInitializers />).container
    })
    // WindowShowInitializer + WebviewHeartbeatInitializer + selection toolbar restore.
    expect(container.querySelectorAll('[data-testid="liveness-child"]')).toHaveLength(3)
  })

  it.each(["overlay", "popup", "island", "selection-toolbar"] as const)(
    "renders nothing in the %s overlay window even on Tauri",
    async (role) => {
      isTauriMock.mockReturnValue(true)
      mockPetRole = role
      let container!: HTMLElement
      await act(async () => {
        container = render(<WindowLivenessInitializers />).container
      })
      expect(container.querySelectorAll('[data-testid="liveness-child"]')).toHaveLength(0)
    }
  )
})
