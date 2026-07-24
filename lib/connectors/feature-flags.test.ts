/** @jest-environment jsdom */

import {
  LARK_FEATURE_FLAGS_STORAGE_KEY,
  getLarkStrictCallbackAuthorizationMode,
  isLarkFeatureEnabled,
  isLarkPrincipalRegistryEnabled,
} from "./feature-flags"

const ENV_KEYS = [
  "COGNIA_LARK_PRINCIPAL_REGISTRY",
  "COGNIA_LARK_WEB_SSO",
  "COGNIA_LARK_CHAT_TAB",
  "COGNIA_LARK_NATIVE_SLASH",
  "COGNIA_LARK_MESSAGE_SHORTCUT",
  "COGNIA_LARK_PLUS_MENU",
  "COGNIA_LARK_STRICT_CALLBACK_AUTH",
]

describe("lark connector feature flags", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    window.localStorage.clear()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it("defaults every entry-surface flag to off", () => {
    expect(isLarkFeatureEnabled("larkPrincipalRegistry")).toBe(false)
    expect(isLarkFeatureEnabled("larkWebSso")).toBe(false)
    expect(isLarkFeatureEnabled("larkChatTab")).toBe(false)
    expect(isLarkFeatureEnabled("larkNativeSlash")).toBe(false)
    expect(isLarkFeatureEnabled("larkMessageShortcut")).toBe(false)
    expect(isLarkFeatureEnabled("larkPlusMenu")).toBe(false)
  })

  it("defaults strict callback authorization to audit (shadow) mode", () => {
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("audit")
  })

  it("reads boolean flags from the environment first", () => {
    process.env.COGNIA_LARK_PRINCIPAL_REGISTRY = "1"
    expect(isLarkPrincipalRegistryEnabled()).toBe(true)
    process.env.COGNIA_LARK_PRINCIPAL_REGISTRY = "false"
    expect(isLarkPrincipalRegistryEnabled({ settings: { larkPrincipalRegistry: true } })).toBe(
      false
    )
  })

  it("falls back to the per-adapter settings override", () => {
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: true } })).toBe(true)
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: "on" } })).toBe(true)
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: "off" } })).toBe(false)
    // Unrecognized values fall through rather than turning the flag on.
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: "yes" } })).toBe(false)
  })

  it("falls back to localStorage in the browser", () => {
    window.localStorage.setItem(
      LARK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ larkWebSso: true, larkStrictCallbackAuthorization: "enforce" })
    )
    expect(isLarkFeatureEnabled("larkWebSso")).toBe(true)
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("enforce")
  })

  it("survives corrupt localStorage payloads", () => {
    window.localStorage.setItem(LARK_FEATURE_FLAGS_STORAGE_KEY, "{not json")
    expect(isLarkFeatureEnabled("larkWebSso")).toBe(false)
    window.localStorage.setItem(LARK_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify("nope"))
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("audit")
  })

  it("parses every strict-auth mode spelling", () => {
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "audit"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("audit")
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "enforce"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("enforce")
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "true"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("enforce")
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "off"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("off")
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "0"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("off")
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "garbage"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("audit")
  })

  it("prefers settings over storage for strict-auth mode", () => {
    window.localStorage.setItem(
      LARK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ larkStrictCallbackAuthorization: "enforce" })
    )
    expect(
      getLarkStrictCallbackAuthorizationMode({
        settings: { larkStrictCallbackAuthorization: "off" },
      })
    ).toBe("off")
    expect(
      getLarkStrictCallbackAuthorizationMode({
        settings: { larkStrictCallbackAuthorization: true },
      })
    ).toBe("enforce")
  })
})
