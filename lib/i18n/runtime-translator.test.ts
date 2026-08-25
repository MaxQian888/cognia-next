/**
 * @jest-environment jsdom
 *
 * jsdom because `@/stores/settings` reaches for `localStorage` on import.
 *
 * `next-intl` ships ESM that Jest does not transform, which is why
 * `jest.setup.ts` replaces the whole package. So this suite mocks it locally
 * with a `createTranslator` spy and asserts what this module is actually
 * responsible for: WHICH locale, WHICH bundle, WHICH namespace, and that a
 * language change is not served from a stale cache. Formatting the message is
 * the library's own tested concern, and pretending to cover it here would only
 * be covering a re-implementation.
 */

const getState = jest.fn(() => ({ settings: { language: "zh-CN" } }) as Record<string, unknown>)
const createTranslator = jest.fn(
  (options: { locale: string; messages: Record<string, unknown>; namespace?: string }) =>
    (key: string, values?: Record<string, unknown>) =>
      `${options.locale}|${options.namespace ?? ""}|${key}|${JSON.stringify(values ?? null)}`
)

jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: () => getState() } }))
jest.mock("next-intl", () => ({ createTranslator: (o: never) => createTranslator(o) }))

import {
  __resetRuntimeTranslatorCache,
  currentLocale,
  getRuntimeTranslator,
} from "./runtime-translator"

beforeEach(() => {
  __resetRuntimeTranslatorCache()
  createTranslator.mockClear()
  getState.mockReset().mockReturnValue({ settings: { language: "zh-CN" } })
})

describe("currentLocale", () => {
  it("follows the persisted UI language, not the host", async () => {
    expect(await currentLocale()).toBe("zh-CN")
  })

  it("falls back to the default for an unset or bogus language", async () => {
    getState.mockReturnValue({ settings: {} })
    expect(await currentLocale()).toBe("en")
    getState.mockReturnValue({ settings: { language: "kl-KL" } })
    expect(await currentLocale()).toBe("en")
  })

  it("falls back rather than throwing when the store is unreadable", async () => {
    // A background subsystem must not lose its notification because the
    // settings store had not hydrated yet.
    getState.mockImplementation(() => {
      throw new Error("not hydrated")
    })
    expect(await currentLocale()).toBe("en")
  })
})

describe("getRuntimeTranslator", () => {
  it("builds the translator against the user's locale and its message bundle", async () => {
    await getRuntimeTranslator("projectEnvironment.repoConfig")
    expect(createTranslator).toHaveBeenCalledTimes(1)
    const options = createTranslator.mock.calls[0]![0]
    expect(options.locale).toBe("zh-CN")
    expect(options.namespace).toBe("projectEnvironment.repoConfig")
    // The real bundle, not a stub: a translator over an empty object would
    // render every key as its own name and nobody would notice in a test that
    // asserted only on the call shape.
    expect(options.messages).toHaveProperty("projectEnvironment.repoConfig.approve")
  })

  it("passes the key and values straight through", async () => {
    const t = await getRuntimeTranslator("ns")
    expect(t("a.b", { x: 1 })).toBe(`zh-CN|ns|a.b|{"x":1}`)
    expect(t("a.b")).toBe(`zh-CN|ns|a.b|null`)
  })

  it("omits the namespace entirely when none is given", async () => {
    await getRuntimeTranslator()
    expect(createTranslator.mock.calls[0]![0]).not.toHaveProperty("namespace")
  })

  it("falls back to the key itself rather than throwing on a missing message", async () => {
    // Verified through the option the library is handed, since the library is
    // what applies it.
    await getRuntimeTranslator("ns")
    const options = createTranslator.mock.calls[0]![0] as unknown as {
      getMessageFallback: (input: { key: string }) => string
      onError: (error: unknown) => void
    }
    expect(options.getMessageFallback({ key: "missing.key" })).toBe("ns.missing.key")
    expect(() => options.onError(new Error("boom"))).not.toThrow()
  })

  it("re-resolves after a language change instead of serving the old bundle", async () => {
    await getRuntimeTranslator("ns")
    getState.mockReturnValue({ settings: { language: "en" } })
    await getRuntimeTranslator("ns")
    expect(createTranslator.mock.calls.map((c) => c[0].locale)).toEqual(["zh-CN", "en"])
  })

  it("loads each locale's bundle once", async () => {
    // The bundle is a ~930KB dynamic import; resolving it per notification
    // would be a real cost on a busy scheduler.
    getState.mockReturnValue({ settings: { language: "en" } })
    await getRuntimeTranslator("a")
    await getRuntimeTranslator("b")
    const [first, second] = createTranslator.mock.calls.map((c) => c[0].messages)
    expect(first).toBe(second)
  })
})
