import { describe, expect, it } from "vitest"

import { testEnv } from "../test/helpers"
import {
  ConfigError,
  enabledProviders,
  parseOrigin,
  parseSecrets,
  readConfig,
  readProviders,
} from "./config"
import type { Env } from "./env"

const SECRET = "s".repeat(40)

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: testEnv.DB,
    SERVICE_ENV: "production",
    BASE_URL: "https://id.cognia.cn",
    SYNC_AUDIENCE: "https://sync.cognia.cn",
    WEB_ORIGINS: "https://app.cognia.cn",
    BETTER_AUTH_SECRETS: `1:${SECRET}`,
    ...overrides,
  }
}

describe("readConfig", () => {
  it("derives the issuer and normalises origins", () => {
    const config = readConfig(
      env({ WEB_ORIGINS: " https://app.cognia.cn/ ,https://app.cognia.cn" })
    )
    expect(config.issuer).toBe("https://id.cognia.cn/api/auth")
    expect(config.webOrigins).toEqual(["https://app.cognia.cn"])
    expect(config.coolingOffDays).toBe(7)
    expect(config.providers).toEqual({})
  })

  it("refuses plain http in production and paths in origins", () => {
    expect(() => readConfig(env({ BASE_URL: "http://localhost:8787" }))).toThrow(ConfigError)
    expect(() => readConfig(env({ WEB_ORIGINS: "http://localhost:3000" }))).toThrow(ConfigError)
    expect(() => readConfig(env({ BASE_URL: "https://id.cognia.cn/api" }))).toThrow(
      /without a path/
    )
    expect(() => readConfig(env({ BASE_URL: "not a url" }))).toThrow(/not a URL/)
  })

  it("allows loopback http outside production", () => {
    const config = readConfig(
      env({
        SERVICE_ENV: "dev",
        BASE_URL: "http://localhost:8787",
        WEB_ORIGINS: "http://localhost:3000",
      })
    )
    expect(config.issuer).toBe("http://localhost:8787/api/auth")
    expect(() => parseOrigin("http://example.com", "dev", "X")).toThrow(/https/)
  })

  it("validates the cooling-off period and the audience", () => {
    expect(() => readConfig(env({ ACCOUNT_DELETION_COOLING_OFF_DAYS: "0" }))).toThrow(ConfigError)
    expect(() => readConfig(env({ ACCOUNT_DELETION_COOLING_OFF_DAYS: "2.5" }))).toThrow(ConfigError)
    expect(readConfig(env({ ACCOUNT_DELETION_COOLING_OFF_DAYS: "1" })).coolingOffDays).toBe(1)
    expect(() => readConfig(env({ SYNC_AUDIENCE: "" }))).toThrow(/SYNC_AUDIENCE/)
  })
})

describe("parseSecrets", () => {
  it("reads versions newest first", () => {
    expect(parseSecrets(`2:${SECRET}b, 1:${SECRET}a`)).toEqual([
      { version: 2, value: `${SECRET}b` },
      { version: 1, value: `${SECRET}a` },
    ])
  })

  it("refuses missing, short, repeated or malformed secrets", () => {
    expect(() => parseSecrets(undefined)).toThrow(/not set/)
    expect(() => parseSecrets("1:short")).toThrow(/shorter/)
    expect(() => parseSecrets(`1:${SECRET},1:${SECRET}`)).toThrow(/repeats/)
    expect(() => parseSecrets(SECRET)).toThrow(/<version>:<secret>/)
    expect(() => parseSecrets(`0:${SECRET}`)).toThrow(/<version>:<secret>/)
  })
})

describe("readProviders", () => {
  it("enables a provider only with all of its credentials", () => {
    const providers = readProviders(
      env({
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        FEISHU_APP_ID: " cli_x ",
        FEISHU_APP_SECRET: "s",
      })
    )
    expect(providers.github).toEqual({ clientId: "id", clientSecret: "secret" })
    expect(providers.feishu).toEqual({ appId: "cli_x", appSecret: "s" })
    expect(enabledProviders({ providers })).toEqual(["feishu", "github"])
  })

  it("refuses a half-configured provider", () => {
    expect(() => readProviders(env({ GOOGLE_CLIENT_ID: "id" }))).toThrow(
      /Google is partially configured; missing clientSecret/
    )
    expect(() => readProviders(env({ APPLE_TEAM_ID: "t", APPLE_KEY_ID: "k" }))).toThrow(/Apple/)
    expect(() => readProviders(env({ APPLE_APP_BUNDLE_ID: "com.cognia.mobile" }))).toThrow(
      /APPLE_APP_BUNDLE_ID/
    )
  })

  it("reads Apple with an optional bundle id", () => {
    const providers = readProviders(
      env({
        APPLE_SERVICE_ID: "cn.cognia.signin",
        APPLE_TEAM_ID: "TEAM",
        APPLE_KEY_ID: "KEY",
        APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
        APPLE_APP_BUNDLE_ID: "com.cognia.mobile",
      })
    )
    expect(providers.apple).toMatchObject({
      serviceId: "cn.cognia.signin",
      appBundleId: "com.cognia.mobile",
    })
    expect(enabledProviders({ providers })).toEqual(["apple"])
  })
})
