import { HOST_INJECTED_API_KEY } from "./proxy-fetch"
import { mintLiveToken, type MintLiveTokenDeps } from "./token"

// Arrow-deferred so the hoisted `jest.mock` factory never touches this const
// before its initializer runs (the repo's documented TDZ trap).
const mockScreen = jest.fn<string | null, [string]>()

jest.mock("../realtime-session", () => ({
  screenLiveVoiceText: (text: string) => mockScreen(text),
}))

const BASE = {
  provider: "openai",
  modelId: "gpt-realtime-2.1",
  voice: "marin",
} as const

/** A stand-in for the host-relaying fetch, so no IPC seam is touched. */
const hostFetch = jest.fn() as unknown as typeof fetch
const createFetch = jest.fn(() => hostFetch)

/** Deps that keep every test off the real platform detector and SDK. */
function deps(overrides: MintLiveTokenDeps = {}): MintLiveTokenDeps {
  return { isTauri: () => false, createFetch, ...overrides }
}

function adapterReturning(secret: unknown) {
  const adapter = { doCreateClientSecret: jest.fn().mockResolvedValue(secret) }
  return Object.assign(jest.fn().mockResolvedValue(adapter), { adapter })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockScreen.mockImplementation((text) => text)
  createFetch.mockReturnValue(hostFetch)
})

describe("mintLiveToken — desktop (Tauri)", () => {
  it("mints through the adapter over the host-relaying fetch", async () => {
    const createAdapter = adapterReturning({
      token: "ek_secret",
      url: "wss://api.openai.com/v1/realtime",
      expiresAt: 1234,
    })

    const minted = await mintLiveToken(BASE, deps({ isTauri: () => true, createAdapter }))

    expect(createFetch).toHaveBeenCalledWith("openai")
    expect(createAdapter).toHaveBeenCalledWith(expect.objectContaining({ fetch: hostFetch }))
    expect(minted).toEqual({
      token: "ek_secret",
      url: "wss://api.openai.com/v1/realtime",
      expiresAt: 1234,
      // Returned so the transport parses events with the very adapter that
      // minted the token, rather than a rebuilt look-alike.
      adapter: createAdapter.adapter,
      // Post-gate text, so the controller's session-update repeats exactly
      // what was minted instead of re-screening the raw persona.
      instructions: "",
    })
  })

  it("hands the SDK a placeholder credential, never the real key", async () => {
    // The SDK refuses to build a request without *some* credential, and the
    // host swaps this one out; a real key must never enter the renderer path.
    const createAdapter = adapterReturning({ token: "ek", url: "wss://x" })

    await mintLiveToken(
      { ...BASE, apiKey: "sk-secret" },
      deps({ isTauri: () => true, createAdapter })
    )

    expect(createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: HOST_INJECTED_API_KEY })
    )
    expect(JSON.stringify(createAdapter.mock.calls)).not.toContain("sk-secret")
  })

  it("builds the host fetch for the provider actually being dialled", async () => {
    const createAdapter = adapterReturning({ token: "t", url: "wss://x" })

    await mintLiveToken(
      { ...BASE, provider: "google" },
      deps({ isTauri: () => true, createAdapter })
    )

    expect(createFetch).toHaveBeenCalledWith("google")
  })
})

describe("mintLiveToken — web BYOK", () => {
  it("mints through the adapter and returns its token and URL", async () => {
    const createAdapter = adapterReturning({
      token: "web_token",
      url: "wss://api.openai.com/v1/realtime",
      expiresAt: 99,
    })

    const minted = await mintLiveToken(BASE, deps({ createAdapter }))

    expect(minted).toEqual({
      token: "web_token",
      url: "wss://api.openai.com/v1/realtime",
      expiresAt: 99,
      adapter: createAdapter.adapter,
      instructions: "",
    })
  })

  it("passes BYOK credentials through and installs no host fetch", async () => {
    const createAdapter = adapterReturning({ token: "t", url: "wss://x" })

    await mintLiveToken(
      { ...BASE, apiKey: "sk-test", baseURL: "https://proxy.example" },
      deps({ createAdapter })
    )

    expect(createAdapter).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-realtime-2.1",
      apiKey: "sk-test",
      baseURL: "https://proxy.example",
    })
    expect(createFetch).not.toHaveBeenCalled()
  })

  it("forwards the screened instructions and lifetime in the session config", async () => {
    mockScreen.mockReturnValue("safe")
    const doCreateClientSecret = jest.fn().mockResolvedValue({ token: "t", url: "wss://x" })
    const createAdapter = jest.fn().mockResolvedValue({ doCreateClientSecret })

    await mintLiveToken(
      { ...BASE, instructions: "persona", expiresAfterSeconds: 60 },
      deps({ createAdapter })
    )

    expect(doCreateClientSecret).toHaveBeenCalledWith({
      expiresAfterSeconds: 60,
      sessionConfig: { instructions: "safe", voice: "marin" },
    })
  })

  it.each([
    ["a missing token", { url: "wss://x" }],
    ["a missing URL", { token: "t" }],
  ])("throws on %s", async (_label, secret) => {
    await expect(
      mintLiveToken(BASE, deps({ createAdapter: adapterReturning(secret) }))
    ).rejects.toThrow(/incomplete realtime client secret/)
  })

  it("propagates an unavailable-provider error from the registry", async () => {
    const createAdapter = jest.fn().mockRejectedValue(new Error("no adapter yet"))

    await expect(
      mintLiveToken({ ...BASE, provider: "doubao" }, deps({ createAdapter }))
    ).rejects.toThrow("no adapter yet")
  })
})

describe("mintLiveToken — PII gate", () => {
  it("skips the gate for empty instructions and sends an empty string", async () => {
    const doCreateClientSecret = jest.fn().mockResolvedValue({ token: "t", url: "wss://x" })
    const createAdapter = jest.fn().mockResolvedValue({ doCreateClientSecret })

    await mintLiveToken({ ...BASE, instructions: "   " }, deps({ createAdapter }))

    expect(mockScreen).not.toHaveBeenCalled()
    expect(doCreateClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ sessionConfig: { instructions: "", voice: "marin" } })
    )
  })

  it("trims before screening so surrounding whitespace is not gated on", async () => {
    mockScreen.mockReturnValue("screened persona")
    const createAdapter = adapterReturning({ token: "t", url: "wss://x" })

    await mintLiveToken({ ...BASE, instructions: "  raw persona  " }, deps({ createAdapter }))

    expect(mockScreen).toHaveBeenCalledWith("raw persona")
  })

  it("fails closed when the gate cannot make the instructions safe", async () => {
    mockScreen.mockReturnValue(null)
    const createAdapter = adapterReturning({ token: "t", url: "wss://x" })

    await expect(
      mintLiveToken({ ...BASE, instructions: "leak me" }, deps({ createAdapter }))
    ).rejects.toThrow(/PII redaction gate/)
    expect(createAdapter).not.toHaveBeenCalled()
  })

  it("gates before any adapter or host fetch is built on desktop", async () => {
    mockScreen.mockReturnValue(null)
    const createAdapter = adapterReturning({ token: "t", url: "wss://x" })

    await expect(
      mintLiveToken(
        { ...BASE, instructions: "leak me" },
        deps({ isTauri: () => true, createAdapter })
      )
    ).rejects.toThrow(/PII redaction gate/)
    expect(createAdapter).not.toHaveBeenCalled()
    expect(createFetch).not.toHaveBeenCalled()
  })
})
