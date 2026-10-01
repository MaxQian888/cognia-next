import {
  listSecretConfigFields,
  mergeKeepingSecrets,
  missingSecretFields,
  stripSecretConfig,
} from "./config-secrets"

const manifest = {
  configSchema: {
    type: "object",
    properties: {
      token: { type: "string", secret: true },
      apiKey: { type: "string", secret: true },
      region: { type: "string" },
      nested: { type: "object", properties: { inner: { type: "string" } } },
    },
  },
}

describe("config secrets", () => {
  it("lists only top-level secret fields, sorted", () => {
    expect(listSecretConfigFields(manifest)).toEqual(["apiKey", "token"])
    expect(listSecretConfigFields({})).toEqual([])
    expect(listSecretConfigFields(null)).toEqual([])
    expect(listSecretConfigFields({ configSchema: { properties: null } })).toEqual([])
  })

  it("strips secrets without mutating the input", () => {
    const config = { token: "t", region: "eu", nested: { inner: "x" } }
    expect(stripSecretConfig(config, manifest)).toEqual({ region: "eu", nested: { inner: "x" } })
    expect(config.token).toBe("t")
    expect(stripSecretConfig(undefined, manifest)).toEqual({})
  })

  it("keeps the current secrets when applying copied config", () => {
    expect(
      mergeKeepingSecrets(
        { token: "from-copy", region: "us" },
        { token: "mine", apiKey: "k", region: "eu" },
        manifest
      )
    ).toEqual({ region: "us", token: "mine", apiKey: "k" })
    // A secret the plugin never had stays absent rather than copied in.
    expect(mergeKeepingSecrets({ token: "from-copy" }, {}, manifest)).toEqual({})
  })

  it("reports secret fields with no value", () => {
    expect(missingSecretFields({ token: "t", apiKey: "" }, manifest)).toEqual(["apiKey"])
    expect(missingSecretFields(undefined, manifest)).toEqual(["apiKey", "token"])
  })
})
