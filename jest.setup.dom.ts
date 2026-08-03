import "@testing-library/jest-dom"
import { configure as configureTestingLibrary } from "@testing-library/dom"

// jsdom omits `window.matchMedia` — provide a default (non-matching) stub so
// viewport hooks render their desktop branch unless a test overrides it.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  ;(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver
}
if (typeof (window as unknown as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  ;(window as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver
}

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [] as unknown[]
  }
  root = null
  rootMargin = ""
  thresholds: number[] = []
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  ;(
    globalThis as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver
}
if (
  typeof (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ===
  "undefined"
) {
  ;(
    window as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver
}

// Radix primitives call methods that jsdom does not implement.
if (typeof Element.prototype.hasPointerCapture !== "function") {
  Element.prototype.hasPointerCapture = function () {
    return false
  }
}
if (typeof Element.prototype.releasePointerCapture !== "function") {
  Element.prototype.releasePointerCapture = function () {}
}
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function () {}
}

if (typeof (window as { structuredClone?: unknown }).structuredClone !== "function") {
  ;(window as unknown as { structuredClone: typeof structuredClone }).structuredClone = (
    globalThis as { structuredClone: typeof structuredClone }
  ).structuredClone
}

// Plugin per-call consent auto-responder. Tests that exercise consent directly
// can set `__PLUGIN_CONSENT_AUTO` to "deny" or "off".
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const consent = require("@/lib/plugin/security/consent-broker") as {
    getPluginConsentBroker: () => {
      respond: (id: string, response: { allow: boolean; persist: boolean }) => boolean
    }
    PLUGIN_CONSENT_REQUEST_EVENT: string
  }
  const flags = globalThis as { __PLUGIN_CONSENT_AUTO?: "allow" | "deny" | "off" }
  flags.__PLUGIN_CONSENT_AUTO ??= "allow"
  window.addEventListener(consent.PLUGIN_CONSENT_REQUEST_EVENT, (event: Event) => {
    const mode = flags.__PLUGIN_CONSENT_AUTO
    if (mode === "off") return
    const detail = (event as CustomEvent<{ requestId: string }>).detail
    if (!detail?.requestId) return
    consent.getPluginConsentBroker().respond(detail.requestId, {
      allow: mode !== "deny",
      persist: false,
    })
  })
} catch {
  // consent-broker not resolvable in this environment — skip.
}

// Full-suite CPU contention can push otherwise-fast waitFor assertions past
// Testing Library's 1s default. Keep the existing safety margin until the
// post-migration worker benchmark proves a lower global timeout is stable.
configureTestingLibrary({ asyncUtilTimeout: 5000 })
