import { transport } from "@/lib/tauri"

import { discoverOpencodeAuth, saveOpencodeZenKey } from "./discovery"

const sampleEntries = [
  {
    subProvider: "anthropic",
    kind: "api-key",
    payloadJson: '{"apiKey":"sk-ant-1"}',
  },
  {
    subProvider: "openai",
    kind: "api-key",
    payloadJson: '{"apiKey":"sk-1"}',
  },
  {
    subProvider: "opencode-zen",
    kind: "oauth",
    payloadJson: '{"type":"oauth","access":"ozk"}',
  },
]

beforeEach(() => {
  jest.spyOn(transport, "call")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("discoverOpencodeAuth", () => {
  it("forwards through opencode_oauth_discover and returns the whitelisted entries", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce({
      authJsonPath: "/home/u/.local/share/opencode/auth.json",
      entries: sampleEntries,
    })
    const got = await discoverOpencodeAuth()
    expect(transport.call).toHaveBeenCalledWith("opencode_oauth_discover")
    expect(got?.entries.length).toBe(3)
  })

  it("returns null when the path is unresolvable", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(undefined)
    expect(await discoverOpencodeAuth()).toBeNull()
  })

  it("drops any non-whitelisted entry (defence-in-depth against Rust drift)", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce({
      authJsonPath: "/p",
      entries: [...sampleEntries, { subProvider: "groq", kind: "api-key", payloadJson: "{}" }],
    })
    const got = await discoverOpencodeAuth()
    expect(got?.entries.map((e) => e.subProvider)).toEqual(["anthropic", "openai", "opencode-zen"])
  })

  it("propagates parse errors", async () => {
    ;(transport.call as jest.Mock).mockRejectedValueOnce("parse error")
    await expect(discoverOpencodeAuth()).rejects.toBe("parse error")
  })

  it("tolerates an empty entries list", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce({
      authJsonPath: "/p",
      entries: [],
    })
    const got = await discoverOpencodeAuth()
    expect(got?.entries).toEqual([])
  })
})

describe("saveOpencodeZenKey", () => {
  it("forwards access token + base URL + label", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce({
      id: "a",
      label: "Personal Zen",
      credential: { provider: "opencode-zen", accessToken: "ozk", storedAtMs: 0 },
      createdAtMs: 0,
      lastUsedAtMs: 0,
    })
    await saveOpencodeZenKey({
      accessToken: "ozk",
      baseUrl: "https://zen.example",
      label: "Personal Zen",
    })
    expect(transport.call).toHaveBeenCalledWith("opencode_save_zen_key", {
      accessToken: "ozk",
      baseUrl: "https://zen.example",
      label: "Personal Zen",
    })
  })

  it("trims a blank base URL to null", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce({
      id: "a",
      credential: { provider: "opencode-zen", accessToken: "ozk", storedAtMs: 0 },
      createdAtMs: 0,
      lastUsedAtMs: 0,
    })
    await saveOpencodeZenKey({ accessToken: "ozk", baseUrl: "   " })
    expect(transport.call).toHaveBeenLastCalledWith(
      "opencode_save_zen_key",
      expect.objectContaining({ baseUrl: null })
    )
  })

  it("trims a blank label to null", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce({
      id: "a",
      credential: { provider: "opencode-zen", accessToken: "ozk", storedAtMs: 0 },
      createdAtMs: 0,
      lastUsedAtMs: 0,
    })
    await saveOpencodeZenKey({ accessToken: "ozk", label: "" })
    expect(transport.call).toHaveBeenLastCalledWith(
      "opencode_save_zen_key",
      expect.objectContaining({ label: null })
    )
  })
})
