import { act, renderHook } from "@testing-library/react"

import {
  __resetPwaInstallStateForTests,
  attachInstallListeners,
  type BeforeInstallPromptEventLike,
} from "@/lib/pwa/install-state"

import { useInstallPrompt } from "./use-install-prompt"

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: jest.fn((query: string) => ({
      matches: query.includes("standalone") ? matches : false,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
      onchange: null,
    })),
  })
}

function fireInstallPromptEvent(): void {
  const event = new Event("beforeinstallprompt", {
    cancelable: true,
  }) as BeforeInstallPromptEventLike
  event.prompt = jest.fn().mockResolvedValue(undefined)
  event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" })
  window.dispatchEvent(event)
}

beforeEach(() => {
  __resetPwaInstallStateForTests()
  stubMatchMedia(false)
})

afterEach(() => {
  __resetPwaInstallStateForTests()
})

describe("useInstallPrompt", () => {
  it("reports unavailable by default", () => {
    const { result } = renderHook(() => useInstallPrompt())
    expect(result.current.status).toBe("unavailable")
  })

  it("flips to installable when beforeinstallprompt lands", () => {
    const detach = attachInstallListeners()
    const { result } = renderHook(() => useInstallPrompt())
    act(() => fireInstallPromptEvent())
    expect(result.current.status).toBe("installable")
    detach()
  })

  it("flips to installed on appinstalled", () => {
    const detach = attachInstallListeners()
    const { result } = renderHook(() => useInstallPrompt())
    act(() => {
      window.dispatchEvent(new Event("appinstalled"))
    })
    expect(result.current.status).toBe("installed")
    detach()
  })

  it("install() resolves the prompt outcome", async () => {
    const detach = attachInstallListeners()
    const { result } = renderHook(() => useInstallPrompt())
    act(() => fireInstallPromptEvent())
    await act(async () => {
      await expect(result.current.install()).resolves.toBe("accepted")
    })
    detach()
  })
})
