import { render, act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { startupMessages } from "@/i18n/messages"

import { WindowLivenessInitializers } from "./window-liveness-initializers"

jest.mock("./window-show-initializer", () => ({
  WindowShowInitializer: () => (
    <span data-testid="liveness-child" data-module="window-show-initializer" />
  ),
}))

// Replace every `next/dynamic(...)` call with a lightweight stub so we can
// assert which gated children render without pulling the real desktop subsystem
// graphs (Tauri window API, watchdog) into the test. The loader is never called
// — its source is read instead, so the stub records *which* module each child
// stands for and assertions can name them rather than just counting.
jest.mock("next/dynamic", () => (loader: unknown) => {
  const source = typeof loader === "function" ? loader.toString() : ""
  const moduleId = source.match(/require\(\s*["']([^"']+)["']/)?.[1] ?? "unknown"
  const Stub = () => <span data-testid="liveness-child" data-module={moduleId} />
  Stub.displayName = "MockLivenessChild"
  return Stub
})

function mountedModules(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="liveness-child"]')]
    .map((node) => node.getAttribute("data-module") ?? "")
    .map((id) => id.split("/").pop() ?? "")
    .sort()
}

const isTauriMock = jest.fn()
jest.mock("@/lib/native/utils", () => ({
  isTauri: () => isTauriMock(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
const minimize = jest.fn().mockResolvedValue(undefined)
const toggleMaximize = jest.fn().mockResolvedValue(undefined)
const close = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}))

function renderLiveness() {
  return render(
    <NextIntlClientProvider locale="en" messages={startupMessages.en}>
      <WindowLivenessInitializers />
    </NextIntlClientProvider>
  )
}

let mockPetRole: "main" | "web" | "overlay" | "popup" | "island" | "selection-toolbar" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island" || role === "selection-toolbar",
}))

describe("WindowLivenessInitializers", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    isTauriMock.mockReset()
    mockPetRole = "main"
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" })
  })

  it("keeps window controls usable before the account and cloud sign-in gates pass", async () => {
    isTauriMock.mockReturnValue(true)
    const user = userEvent.setup()
    const { container } = renderLiveness()
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "Minimize" }))
    await user.click(screen.getByRole("button", { name: "Maximize" }))
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(minimize).toHaveBeenCalledTimes(1)
    expect(toggleMaximize).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(
      container.querySelector("[data-window-controls-fallback] [data-window-controls]")
    ).toHaveClass("native-window-controls-fallback")
  })

  it("renders nothing on web (isTauri() === false)", async () => {
    isTauriMock.mockReturnValue(false)
    let container!: HTMLElement
    await act(async () => {
      container = renderLiveness().container
    })
    expect(container.querySelectorAll('[data-testid="liveness-child"]')).toHaveLength(0)
  })

  it("renders the reveal + heartbeat once mounted on the Tauri main window", async () => {
    isTauriMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = renderLiveness().container
    })
    expect(mountedModules(container)).toEqual([
      "exit-confirmation-dialog",
      "selection-toolbar-restore-initializer",
      "webview-heartbeat-initializer",
      "window-show-initializer",
    ])
  })

  it("answers the close button above AccountGate and the desktop-tools capability", async () => {
    // Rust replies to the close (X) button with `api.prevent_close()` and emits
    // `app://close-requested`, so an unmounted listener does not mean "close
    // without asking" — the window stops closing at all. This dialog therefore
    // cannot live in `DesktopOnlyInitializers`, which renders nothing until the
    // per-route `desktop-tools` capability is requested (`/` never requests it,
    // and the dev `main` boot profile requests only `core-chat`) and until an
    // account is unlocked.
    isTauriMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = renderLiveness().container
    })
    expect(mountedModules(container)).toContain("exit-confirmation-dialog")
  })

  it.each(["overlay", "popup", "island", "selection-toolbar"] as const)(
    "renders nothing in the %s overlay window even on Tauri",
    async (role) => {
      isTauriMock.mockReturnValue(true)
      mockPetRole = role
      let container!: HTMLElement
      await act(async () => {
        container = renderLiveness().container
      })
      expect(container.querySelectorAll('[data-testid="liveness-child"]')).toHaveLength(0)
    }
  )
})
