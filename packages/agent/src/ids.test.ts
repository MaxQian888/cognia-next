import { randomUUID } from "./ids"

describe("randomUUID", () => {
  const nativeCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true })
  })

  it("returns distinct RFC 4122 v4 identifiers", () => {
    const first = randomUUID()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first).not.toBe(randomUUID())
  })

  it("falls back to getRandomValues where randomUUID is gated on a secure context", () => {
    // The desktop WebView can be served from a custom scheme that some engines
    // do not treat as a secure context, which hides `crypto.randomUUID` while
    // leaving `getRandomValues` available.
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) },
      configurable: true,
    })

    const value = randomUUID()
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(value).not.toBe(randomUUID())
  })

  it("fails loudly rather than minting a guessable id", () => {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true })

    expect(() => randomUUID()).toThrow("Web Crypto is unavailable")
  })
})
