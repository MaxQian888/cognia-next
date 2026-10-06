import type {
  FullPluginContext,
  NativeVideoInfo,
  PluginContext,
  PluginProjectWebviewAPI,
  VideoAnalysisFrame,
  VideoAnalysisManifest,
  VideoAnalysisMode,
  VideoAnalysisOptions,
} from "./index"

describe("public FullPluginContext", () => {
  it("exports only the bounded document methods to sandboxed project clients", () => {
    type RequiredMethods =
      | "listKnowledgeDocuments"
      | "readKnowledgeOutline"
      | "readKnowledgeRange"
      | "locateKnowledgeDocument"
      | "addKnowledgeFile"
      | "updateKnowledgeFile"
      | "removeKnowledgeFile"
    const assertNever = <Value extends never>(): Value | undefined => undefined
    expect(assertNever<Exclude<RequiredMethods, keyof PluginProjectWebviewAPI>>()).toBeUndefined()
    expect(assertNever<Exclude<keyof PluginProjectWebviewAPI, RequiredMethods>>()).toBeUndefined()
  })
  it("requires every API mounted by the full host context", () => {
    type OptionalKeys<T> = {
      [Key in keyof T]-?: object extends Pick<T, Key> ? Key : never
    }[keyof T]
    type CriticalKeys = "memory" | "pet" | "webview" | "auth" | "uri"
    type UnexpectedOptionalKeys = Extract<CriticalKeys, OptionalKeys<FullPluginContext>>
    const assertNever = <Value extends never>(): Value | undefined => undefined

    expect(assertNever<UnexpectedOptionalKeys>()).toBeUndefined()
  })

  it("exposes formerly hidden namespaces on PluginContext itself", () => {
    type RequiredKeys =
      | "extensions"
      | "theme"
      | "i18n"
      | "notifications"
      | "canvas"
      | "artifact"
      | "messagePart"
      | "toolResult"
      | "session"
      | "permissions"
    type MissingKeys = Exclude<RequiredKeys, keyof PluginContext>
    const assertNever = <Value extends never>(): Value | undefined => undefined

    expect(assertNever<MissingKeys>()).toBeUndefined()
  })

  it("exports the native video-analysis contract from the published context surface", () => {
    const assertTypes = <
      _T extends
        | NativeVideoInfo
        | VideoAnalysisFrame
        | VideoAnalysisManifest
        | VideoAnalysisMode
        | VideoAnalysisOptions,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
