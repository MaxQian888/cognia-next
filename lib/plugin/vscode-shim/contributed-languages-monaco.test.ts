import {
  installContributedLanguageSync,
  toMonacoLanguageConfiguration,
  type MonacoLanguagesApi,
} from "./contributed-languages-monaco"
import {
  __resetLanguagesForTesting,
  registerLanguage,
  unregisterLanguagesByPlugin,
} from "@/lib/plugin/bridge/languages-bridge"

function makeFakeMonaco() {
  const registered: string[] = []
  const configured: string[] = []
  const disposed: string[] = []
  const api: MonacoLanguagesApi = {
    register: (lang) => registered.push(lang.id),
    setLanguageConfiguration: (id) => {
      configured.push(id)
      return { dispose: () => disposed.push(id) }
    },
  }
  return { api, registered, configured, disposed }
}

describe("contributed-languages-monaco", () => {
  beforeEach(() => __resetLanguagesForTesting())

  describe("toMonacoLanguageConfiguration", () => {
    it("returns undefined for no config", () => {
      expect(toMonacoLanguageConfiguration(undefined)).toBeUndefined()
    })

    it("passes through comments/brackets and compiles regex fields", () => {
      const out = toMonacoLanguageConfiguration({
        comments: { lineComment: "//" },
        brackets: [["{", "}"]],
        wordPattern: "[a-z]+",
        indentationRules: { increaseIndentPattern: "\\{$", decreaseIndentPattern: "^\\}" },
        folding: { markers: { start: "#region", end: "#endregion" } },
      })
      expect(out?.comments).toEqual({ lineComment: "//" })
      expect(out?.wordPattern).toBeInstanceOf(RegExp)
      expect(
        (out?.indentationRules as { increaseIndentPattern: RegExp }).increaseIndentPattern
      ).toBeInstanceOf(RegExp)
      expect((out?.folding as { markers: { start: RegExp } }).markers.start).toBeInstanceOf(RegExp)
    })

    it("drops invalid regex fields rather than throwing", () => {
      const out = toMonacoLanguageConfiguration({ wordPattern: "[" })
      expect(out).toBeUndefined()
    })
  })

  describe("installContributedLanguageSync", () => {
    it("registers languages already in the bridge", () => {
      registerLanguage({ pluginId: "p", language: { id: "svelte", extensions: [".svelte"] } })
      const { api, registered } = makeFakeMonaco()
      installContributedLanguageSync(api)
      expect(registered).toContain("svelte")
    })

    it("registers + configures languages added after install, and disposes on unregister", async () => {
      // The bridge emits register/unregister via queueMicrotask, so flush.
      const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))
      const { api, registered, configured, disposed } = makeFakeMonaco()
      const dispose = installContributedLanguageSync(api)

      registerLanguage({
        pluginId: "p",
        language: { id: "vue", configuration: undefined },
        configurationText: JSON.stringify({ comments: { lineComment: "//" } }),
      })
      await flush()

      expect(registered).toContain("vue")
      expect(configured).toContain("vue")

      unregisterLanguagesByPlugin("p")
      await flush()
      expect(disposed).toContain("vue")

      dispose()
    })

    it("dispose() tears down subscriptions and configurations", () => {
      registerLanguage({
        pluginId: "p",
        language: { id: "toml" },
        configurationText: JSON.stringify({ comments: { lineComment: "#" } }),
      })
      const { api, disposed } = makeFakeMonaco()
      const dispose = installContributedLanguageSync(api)
      dispose()
      expect(disposed).toContain("toml")
    })
  })
})
