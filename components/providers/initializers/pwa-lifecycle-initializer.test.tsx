import { fireEvent, render, waitFor } from "@testing-library/react"

const attachMock = jest.fn(() => jest.fn())
jest.mock("@/lib/pwa/install-state", () => ({
  attachInstallListeners: () => attachMock(),
}))

const detectPlatformMock = jest.fn(() => "web")
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => detectPlatformMock(),
}))

const trackEventMock = jest.fn<Promise<boolean>, unknown[]>(async () => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...a: unknown[]) => trackEventMock(...a),
}))

const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a) },
}))

const runtimeNamespace = jest.fn()
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async (namespace: string) => {
    runtimeNamespace(namespace)
    return (key: string) => `${namespace}.${key}`
  },
}))

import { PwaLifecycleInitializer } from "./pwa-lifecycle-initializer"

interface SwStub {
  controller: object | null
  listeners: Map<string, Set<EventListener>>
  addEventListener: (type: string, cb: EventListener) => void
  removeEventListener: (type: string, cb: EventListener) => void
  fire: (type: string) => void
}

function stubServiceWorker(controller: object | null): SwStub {
  const listeners = new Map<string, Set<EventListener>>()
  const stub: SwStub = {
    controller,
    listeners,
    addEventListener: (type, cb) => {
      const bucket = listeners.get(type) ?? new Set<EventListener>()
      bucket.add(cb)
      listeners.set(type, bucket)
    },
    removeEventListener: (type, cb) => {
      listeners.get(type)?.delete(cb)
    },
    fire: (type) => {
      for (const cb of listeners.get(type) ?? []) cb(new Event(type))
    },
  }
  Object.defineProperty(window.navigator, "serviceWorker", {
    writable: true,
    configurable: true,
    value: stub,
  })
  return stub
}

beforeEach(() => {
  attachMock.mockClear()
  detectPlatformMock.mockReturnValue("web")
  trackEventMock.mockClear()
  toastInfo.mockClear()
  runtimeNamespace.mockClear()
})

describe("<PwaLifecycleInitializer />", () => {
  it("attaches the install capture on the web shell and renders nothing", () => {
    stubServiceWorker(null)
    const { container } = render(<PwaLifecycleInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(attachMock).toHaveBeenCalledTimes(1)
  })

  it("is a no-op off the web shell", () => {
    detectPlatformMock.mockReturnValue("tauri")
    render(<PwaLifecycleInitializer />)
    expect(attachMock).not.toHaveBeenCalled()
  })

  it("reports app.pwa.installed on the appinstalled event", () => {
    stubServiceWorker(null)
    render(<PwaLifecycleInitializer />)
    fireEvent(window, new Event("appinstalled"))
    expect(trackEventMock).toHaveBeenCalledWith("app.pwa.installed", {})
  })

  it("does not toast on the first controllerchange (initial activation)", () => {
    const sw = stubServiceWorker(null)
    render(<PwaLifecycleInitializer />)
    sw.fire("controllerchange")
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it("toasts from the full catalog when a new worker takes over an already-controlled page", async () => {
    const sw = stubServiceWorker({ old: true })
    render(<PwaLifecycleInitializer />)
    sw.fire("controllerchange")
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1))
    // Above AccountGate the provider holds only startup messages, so the toast
    // must not depend on a `settings` namespace from the React provider.
    expect(runtimeNamespace).toHaveBeenCalledWith("settings.about.install")
    expect(toastInfo).toHaveBeenCalledWith("settings.about.install.updateReady")
  })

  it("toasts on every later change once the page has a controller", async () => {
    const sw = stubServiceWorker(null)
    render(<PwaLifecycleInitializer />)
    sw.fire("controllerchange") // first activation — silent
    sw.fire("controllerchange") // a real update
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1))
  })

  it("detaches listeners on unmount", () => {
    const sw = stubServiceWorker({ old: true })
    const { unmount } = render(<PwaLifecycleInitializer />)
    unmount()
    sw.fire("controllerchange")
    expect(toastInfo).not.toHaveBeenCalled()
    expect(trackEventMock).not.toHaveBeenCalled()
  })
})
