import type { FullPluginContext, PluginContext } from "./index"

describe("public FullPluginContext", () => {
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
})
