import type { FullPluginContext } from "./index"

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
})
