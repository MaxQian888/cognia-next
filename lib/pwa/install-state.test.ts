/** @jest-environment jsdom */

import {
  __resetPwaInstallStateForTests,
  attachInstallListeners,
  getInstallStatus,
  isIosManualInstall,
  isStandaloneDisplayMode,
  promptInstall,
  subscribeInstallState,
  type BeforeInstallPromptEventLike,
} from "./install-state"

function stubMatchMedia(matches: boolean) {
  const listeners = new Map<string, Set<(e: Event) => void>>()
  const mql = {
    matches,
    media: "(display-mode: standalone)",
    addEventListener: jest.fn((type: string, cb: (e: Event) => void) => {
      const bucket = listeners.get(type) ?? new Set<(e: Event) => void>()
      bucket.add(cb)
      listeners.set(type, bucket)
    }),
    removeEventListener: jest.fn((type: string, cb: (e: Event) => void) => {
      listeners.get(type)?.delete(cb)
    }),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  }
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: jest.fn(() => mql),
  })
  return mql
}

function fireInstallPromptEvent(): BeforeInstallPromptEventLike {
  const event = new Event("beforeinstallprompt", {
    cancelable: true,
  }) as BeforeInstallPromptEventLike
  event.prompt = jest.fn().mockResolvedValue(undefined)
  event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" })
  window.dispatchEvent(event)
  return event
}

const realUserAgent = window.navigator.userAgent

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    writable: true,
    configurable: true,
    value: ua,
  })
}

beforeEach(() => {
  __resetPwaInstallStateForTests()
  stubMatchMedia(false)
  setUserAgent(realUserAgent)
})

afterEach(() => {
  __resetPwaInstallStateForTests()
})

describe("getInstallStatus", () => {
  it("is unavailable by default", () => {
    expect(getInstallStatus()).toBe("unavailable")
  })

  it("is installable after beforeinstallprompt is captured", () => {
    attachInstallListeners()
    fireInstallPromptEvent()
    expect(getInstallStatus()).toBe("installable")
  })

  it("is installed inside a standalone display-mode window", () => {
    stubMatchMedia(true)
    expect(getInstallStatus()).toBe("installed")
  })

  it("is installed after the appinstalled event", () => {
    attachInstallListeners()
    window.dispatchEvent(new Event("appinstalled"))
    expect(getInstallStatus()).toBe("installed")
  })

  it("is ios-manual on iOS Safari with no prompt support", () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    )
    expect(isIosManualInstall()).toBe(true)
    expect(getInstallStatus()).toBe("ios-manual")
  })

  it("is unavailable for Chrome on iOS (no A2HS there)", () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1"
    )
    expect(isIosManualInstall()).toBe(false)
    expect(getInstallStatus()).toBe("unavailable")
  })
})

describe("beforeinstallprompt capture", () => {
  it("preventDefaults the event so the browser keeps it for our prompt", () => {
    attachInstallListeners()
    const event = new Event("beforeinstallprompt", {
      cancelable: true,
    }) as BeforeInstallPromptEventLike
    event.prompt = jest.fn()
    event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "" })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it("notifies subscribers on capture and on appinstalled", () => {
    const detach = attachInstallListeners()
    const onChange = jest.fn()
    const unsubscribe = subscribeInstallState(onChange)
    fireInstallPromptEvent()
    expect(onChange).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("appinstalled"))
    expect(onChange).toHaveBeenCalledTimes(2)
    unsubscribe()
    detach()
  })

  it("keeps listening until the last attacher detaches (refcounted)", () => {
    const detachA = attachInstallListeners()
    const detachB = attachInstallListeners()
    detachA()
    expect(getInstallStatus()).toBe("unavailable")
    fireInstallPromptEvent()
    expect(getInstallStatus()).toBe("installable")
    detachB()
  })

  it("stops capturing once every attacher detached", () => {
    const detach = attachInstallListeners()
    detach()
    const event = new Event("beforeinstallprompt", {
      cancelable: true,
    }) as BeforeInstallPromptEventLike
    event.prompt = jest.fn()
    event.userChoice = Promise.resolve({ outcome: "accepted", platform: "" })
    window.dispatchEvent(event)
    expect(getInstallStatus()).toBe("unavailable")
  })
})

describe("promptInstall", () => {
  it("resolves unavailable with no captured prompt", async () => {
    await expect(promptInstall()).resolves.toBe("unavailable")
  })

  it("calls prompt() and resolves the user's accepted choice", async () => {
    attachInstallListeners()
    const event = fireInstallPromptEvent()
    await expect(promptInstall()).resolves.toBe("accepted")
    expect(event.prompt).toHaveBeenCalledTimes(1)
  })

  it("resolves dismissed when the user declines", async () => {
    attachInstallListeners()
    const event = new Event("beforeinstallprompt", {
      cancelable: true,
    }) as BeforeInstallPromptEventLike
    event.prompt = jest.fn().mockResolvedValue(undefined)
    event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "" })
    window.dispatchEvent(event)
    await expect(promptInstall()).resolves.toBe("dismissed")
  })

  it("resolves unavailable when prompt() itself rejects", async () => {
    attachInstallListeners()
    const event = new Event("beforeinstallprompt", {
      cancelable: true,
    }) as BeforeInstallPromptEventLike
    event.prompt = jest.fn().mockRejectedValue(new DOMException("consumed", "NotAllowedError"))
    event.userChoice = Promise.resolve({ outcome: "accepted", platform: "" })
    window.dispatchEvent(event)
    await expect(promptInstall()).resolves.toBe("unavailable")
  })

  it("is single-use — the deferred event is consumed", async () => {
    attachInstallListeners()
    fireInstallPromptEvent()
    await promptInstall()
    expect(getInstallStatus()).toBe("unavailable")
    await expect(promptInstall()).resolves.toBe("unavailable")
  })
})

describe("isStandaloneDisplayMode", () => {
  it("follows the display-mode media query", () => {
    expect(isStandaloneDisplayMode()).toBe(false)
    stubMatchMedia(true)
    expect(isStandaloneDisplayMode()).toBe(true)
  })
})
