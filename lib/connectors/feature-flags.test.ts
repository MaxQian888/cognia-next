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

  it("defaults every entry-surface flag to on", () => {
    expect(isLarkFeatureEnabled("larkPrincipalRegistry")).toBe(true)
    expect(isLarkFeatureEnabled("larkWebSso")).toBe(true)
    expect(isLarkFeatureEnabled("larkChatTab")).toBe(true)
    expect(isLarkFeatureEnabled("larkNativeSlash")).toBe(true)
    expect(isLarkFeatureEnabled("larkMessageShortcut")).toBe(true)
    expect(isLarkFeatureEnabled("larkPlusMenu")).toBe(true)
  })

  it("defaults strict callback authorization to enforce", () => {
    // Audit is not a safe resting state: in it `consumedAt` is never written,
    // so a stale re-click of an approval card can still re-grant a bypass.
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("enforce")
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
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: false } })).toBe(false)
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: "off" } })).toBe(false)
    // Unrecognized values fall through to the default rather than reading as
    // an intentional flip in either direction.
    expect(isLarkFeatureEnabled("larkChatTab", { settings: { larkChatTab: "yes" } })).toBe(true)
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
    expect(isLarkFeatureEnabled("larkWebSso")).toBe(true)
    window.localStorage.setItem(LARK_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify("nope"))
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("enforce")
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
    // Unrecognized spellings fall through to the default rather than
    // silently weakening the mode.
    process.env.COGNIA_LARK_STRICT_CALLBACK_AUTH = "garbage"
    expect(getLarkStrictCallbackAuthorizationMode()).toBe("enforce")
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
