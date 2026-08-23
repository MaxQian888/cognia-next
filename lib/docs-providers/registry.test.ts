jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: jest.fn(() => "tauri"),
}))

import { detectPlatform, type Platform } from "@/lib/platform/detect"
import {
  __clearDocsProvidersForTests,
  docsProviderPrefixes,
  getDocsProvider,
  getDocsProviderByPrefix,
  isDocsProviderHostSupported,
  listAvailableDocsProviders,
  listDocsProviders,
  registerDocsProvider,
  unregisterDocsProvider,
} from "./registry"
import type { DocsProvider } from "./types"

const mockDetectPlatform = detectPlatform as jest.MockedFunction<typeof detectPlatform>

function stubProvider(overrides: Partial<DocsProvider> = {}): DocsProvider {
  return {
    id: "stub",
    mentionPrefix: "stub:",
    kinds: ["doc"],
    hosts: ["tauri"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: async () => {
      throw new Error("not implemented")
    },
    ...overrides,
  }
}

function setPlatform(platform: Platform): void {
  mockDetectPlatform.mockReturnValue(platform)
}

describe("docs provider registry", () => {
  beforeEach(() => {
    __clearDocsProvidersForTests()
    setPlatform("tauri")
  })

  it("registers and resolves by id", () => {
    const provider = stubProvider()
    registerDocsProvider(provider)
    expect(getDocsProvider("stub")).toBe(provider)
    expect(listDocsProviders()).toEqual([provider])
  })

  it("returns undefined for an unknown id", () => {
    expect(getDocsProvider("nope")).toBeUndefined()
  })

  it("unregisters a dynamically contributed provider", () => {
    registerDocsProvider(stubProvider())
    expect(unregisterDocsProvider("stub")).toBe(true)
    expect(unregisterDocsProvider("stub")).toBe(false)
    expect(listDocsProviders()).toEqual([])
  })

  it("throws on a duplicate id", () => {
    registerDocsProvider(stubProvider())
    expect(() => registerDocsProvider(stubProvider())).toThrow(/already registered/)
  })

  it("throws when two providers claim the same mention prefix", () => {
    registerDocsProvider(stubProvider())
    expect(() => registerDocsProvider(stubProvider({ id: "other" }))).toThrow(
      /already used by "stub"/
    )
  })

  it("rejects a mention prefix that is not colon-terminated", () => {
    expect(() => registerDocsProvider(stubProvider({ mentionPrefix: "stub" }))).toThrow(
      /must end with ":"/
    )
  })

  it("maps prefixes back to provider ids", () => {
    const provider = stubProvider()
    registerDocsProvider(provider)
    expect(docsProviderPrefixes()).toEqual([{ prefix: "stub:", providerId: "stub" }])
    expect(getDocsProviderByPrefix("stub:")).toBe(provider)
    expect(getDocsProviderByPrefix("missing:")).toBeUndefined()
  })

  describe("host gating (intentional dormancy — project rule 7, test axis)", () => {
    it("exposes a tauri-only provider on the desktop", () => {
      const provider = stubProvider()
      registerDocsProvider(provider)
      expect(listAvailableDocsProviders()).toEqual([provider])
      expect(isDocsProviderHostSupported(provider)).toBe(true)
    })

    it.each<Platform>(["web", "mobile", "headless"])(
      "hides a tauri-only provider on %s",
      (platform) => {
        const provider = stubProvider()
        registerDocsProvider(provider)
        setPlatform(platform)
        expect(listAvailableDocsProviders()).toEqual([])
        expect(isDocsProviderHostSupported(provider)).toBe(false)
      }
    )

    it("still reports the prefix on an unsupported host so the panel can explain itself", () => {
      registerDocsProvider(stubProvider())
      setPlatform("web")
      expect(docsProviderPrefixes()).toEqual([{ prefix: "stub:", providerId: "stub" }])
    })
  })
})
