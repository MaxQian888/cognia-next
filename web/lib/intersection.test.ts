import { resolveObserverFactory, type ObserverFactory } from "./intersection"

describe("resolveObserverFactory", () => {
  const original = globalThis.IntersectionObserver

  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "IntersectionObserver")
    } else {
      globalThis.IntersectionObserver = original
    }
  })

  it("prefers an injected factory over the platform one", () => {
    const injected = jest.fn() as unknown as ObserverFactory
    expect(resolveObserverFactory(injected)).toBe(injected)
  })

  it("returns null when the engine has no IntersectionObserver", () => {
    Reflect.deleteProperty(globalThis, "IntersectionObserver")
    expect(resolveObserverFactory()).toBeNull()
  })

  it("still honours an injected factory with no platform support", () => {
    Reflect.deleteProperty(globalThis, "IntersectionObserver")
    const injected = jest.fn() as unknown as ObserverFactory
    expect(resolveObserverFactory(injected)).toBe(injected)
  })

  it("constructs a real observer when the platform provides one", () => {
    const ctor = jest.fn()
    globalThis.IntersectionObserver = ctor as unknown as typeof IntersectionObserver

    const factory = resolveObserverFactory()
    expect(factory).not.toBeNull()

    const callback: IntersectionObserverCallback = () => {}
    const options = { threshold: 0.4 }
    factory!(callback, options)

    expect(ctor).toHaveBeenCalledWith(callback, options)
  })
})
