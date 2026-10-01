import { render, act } from "@testing-library/react"

import { MobileNativeSplashInitializer, MobileOnlyInitializers } from "./mobile-only-initializers"
import { registerNativePlugins } from "@/lib/capacitor/register-plugins"
import { hide } from "@/lib/capacitor/splash-screen"

jest.mock("@/lib/capacitor/register-plugins", () => ({ registerNativePlugins: jest.fn() }))
jest.mock("@/lib/capacitor/splash-screen", () => ({ hide: jest.fn() }))

jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="mobile-child" />
  Stub.displayName = "MockMobileChild"
  return Stub
})

const isMobileMock = jest.fn()
jest.mock("@/lib/capacitor/_shared", () => ({
  isMobile: () => isMobileMock(),
}))

describe("MobileOnlyInitializers", () => {
  beforeEach(() => {
    isMobileMock.mockReset()
    jest.mocked(registerNativePlugins).mockReset()
    jest.mocked(registerNativePlugins).mockResolvedValue({
      kind: "registered",
      registered: ["SplashScreen"],
      available: ["SplashScreen"],
    })
    jest.mocked(hide).mockReset()
    jest.mocked(hide).mockResolvedValue({ kind: "ok" })
  })

  it("renders nothing on desktop/web (isMobile() === false)", async () => {
    isMobileMock.mockReturnValue(false)
    let container!: HTMLElement
    await act(async () => {
      container = render(<MobileOnlyInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="mobile-child"]')).toHaveLength(0)
  })

  it("renders the splash once mounted on Capacitor", async () => {
    isMobileMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = render(<MobileOnlyInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="mobile-child"]')).toHaveLength(1)
  })

  it("releases the native splash without waiting for account or host providers", async () => {
    isMobileMock.mockReturnValue(true)
    await act(async () => {
      render(<MobileNativeSplashInitializer />)
    })
    expect(registerNativePlugins).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledWith(180)
  })

  it("does not call the native bridge on web or desktop", async () => {
    isMobileMock.mockReturnValue(false)
    await act(async () => {
      render(<MobileNativeSplashInitializer />)
    })
    expect(registerNativePlugins).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it("does not hide after unmount while bridge registration is pending", async () => {
    isMobileMock.mockReturnValue(true)
    let resolve!: (value: Awaited<ReturnType<typeof registerNativePlugins>>) => void
    jest.mocked(registerNativePlugins).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { unmount } = render(<MobileNativeSplashInitializer />)
    unmount()
    await act(async () => {
      resolve({ kind: "registered", registered: [], available: [] })
    })
    expect(hide).not.toHaveBeenCalled()
  })

  it("keeps the native timeout as fallback when the bridge is unavailable", async () => {
    isMobileMock.mockReturnValue(true)
    jest.mocked(registerNativePlugins).mockResolvedValue({
      kind: "unavailable",
      registered: [],
      available: [],
    })
    await act(async () => {
      render(<MobileNativeSplashInitializer />)
    })
    expect(hide).not.toHaveBeenCalled()
  })
})
