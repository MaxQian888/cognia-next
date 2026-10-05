import { describe, expect, it } from "vitest"

import { testEnv } from "../test/helpers"
import { ConfigError, readConfig } from "./config"

describe("readConfig", () => {
  it("reads the test environment", () => {
    expect(readConfig(testEnv)).toEqual({
      serviceEnv: "test",
      issuer: "https://id.test/api/auth",
      audience: "https://sync.cognia.cn",
      webOrigins: ["https://app.test"],
    })
  })

  it("requires https outside dev and test, and real origins", () => {
    expect(() =>
      readConfig({ ...testEnv, SERVICE_ENV: "production", ISSUER: "http://id.cognia.cn/api/auth" })
    ).toThrow(ConfigError)
    expect(
      readConfig({ ...testEnv, SERVICE_ENV: "dev", ISSUER: "http://localhost:8787/api/auth/" })
        .issuer
    ).toBe("http://localhost:8787/api/auth")
    expect(() => readConfig({ ...testEnv, ISSUER: "" })).toThrow(/ISSUER/)
    expect(() => readConfig({ ...testEnv, SYNC_AUDIENCE: "not a url" })).toThrow(/SYNC_AUDIENCE/)
    expect(() => readConfig({ ...testEnv, WEB_ORIGINS: "https://app.test/path" })).toThrow(
      /non-origin/
    )
  })
})
