import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_OUTPUT_DIR,
  PLATFORMS,
  PLATFORM_FIELDS,
  loadImLiveEnv,
  readConfig,
  registerConfigSecrets,
  selectPlatforms,
} from "./config.mjs"
import { createRedactor } from "./redact.mjs"

/** A fully-populated environment for one platform, and nothing else. */
function envFor(platform, overrides = {}) {
  const env = {}
  for (const spec of Object.values(PLATFORM_FIELDS[platform])) {
    if (spec.optional) continue
    env[spec.env] = `value-for-${spec.env}`
  }
  return { ...env, ...overrides }
}

function envForAll() {
  return PLATFORMS.reduce((acc, p) => ({ ...acc, ...envFor(p) }), {})
}

test("every platform has a field table and at least one secret", () => {
  for (const platform of PLATFORMS) {
    const fields = PLATFORM_FIELDS[platform]
    assert.ok(fields, `${platform} needs a field table`)
    assert.ok(
      Object.values(fields).some((spec) => spec.secret),
      `${platform} must mark at least one field secret so it reaches the redactor`
    )
  }
})

test("every field's env var is unique across all platforms", () => {
  const seen = new Map()
  for (const platform of PLATFORMS) {
    for (const [name, spec] of Object.entries(PLATFORM_FIELDS[platform])) {
      assert.ok(
        !seen.has(spec.env),
        `${spec.env} is claimed by both ${seen.get(spec.env)} and ${platform}.${name}`
      )
      seen.set(spec.env, `${platform}.${name}`)
    }
  }
})

test("a fully-configured platform reports configured with no missing fields", () => {
  const config = readConfig(envFor("telegram"))
  assert.equal(config.platforms.telegram.status, "configured")
  assert.deepEqual(config.platforms.telegram.missing, [])
  assert.equal(
    config.platforms.telegram.values.targetChatId,
    "value-for-IM_LIVE_TELEGRAM_TARGET_CHAT_ID"
  )
})

test("platforms are isolated — one platform's credentials never configure another", () => {
  const config = readConfig(envFor("slack"))
  assert.equal(config.platforms.slack.status, "configured")
  for (const other of PLATFORMS.filter((p) => p !== "slack")) {
    assert.equal(config.platforms[other].status, "not_configured", other)
    assert.ok(config.platforms[other].missing.length > 0, other)
    // And nothing leaked across: no value of another platform is populated.
    for (const [name, spec] of Object.entries(PLATFORM_FIELDS[other])) {
      if (spec.optional) continue
      assert.equal(config.platforms[other].values[name], undefined, `${other}.${name}`)
    }
  }
})

test("missing fields are named by their environment variable", () => {
  const env = envFor("matrix")
  delete env.IM_LIVE_MATRIX_TARGET_ROOM_ID
  const config = readConfig(env)
  assert.deepEqual(config.platforms.matrix.missing, ["IM_LIVE_MATRIX_TARGET_ROOM_ID"])
})

test("whitespace-only values count as missing", () => {
  const config = readConfig(envFor("discord", { IM_LIVE_DISCORD_TARGET_CHANNEL_ID: "   " }))
  assert.equal(config.platforms.discord.status, "not_configured")
  assert.deepEqual(config.platforms.discord.missing, ["IM_LIVE_DISCORD_TARGET_CHANNEL_ID"])
})

test("values are trimmed — a trailing newline from a pasted secret must not break auth", () => {
  const config = readConfig(envFor("lark", { IM_LIVE_LARK_DRIVER_APP_ID: " cli_abc \n" }))
  assert.equal(config.platforms.lark.values.driverAppId, "cli_abc")
})

test("optional fields fall back to their documented default", () => {
  const config = readConfig(envFor("telegram"))
  assert.equal(config.platforms.telegram.values.apiBase, "https://api.telegram.org")
  const overridden = readConfig(
    envFor("telegram", { IM_LIVE_TELEGRAM_API_BASE: "http://127.0.0.1:9" })
  )
  assert.equal(overridden.platforms.telegram.values.apiBase, "http://127.0.0.1:9")
})

test("defaults match the documented budget and can be overridden", () => {
  const base = readConfig({})
  assert.equal(base.turnTimeoutMs, 120_000)
  assert.equal(base.duplicateWindowMs, 10_000)
  assert.equal(base.lockTtlMs, 30 * 60 * 1000)
  assert.equal(base.cleanup, true)
  assert.equal(base.outputDir, DEFAULT_OUTPUT_DIR)

  const tuned = readConfig({ IM_LIVE_TURN_TIMEOUT_MS: "5000", IM_LIVE_KEEP: "1" })
  assert.equal(tuned.turnTimeoutMs, 5000)
  assert.equal(tuned.cleanup, false)
})

test("a non-numeric budget is an error, not a silent NaN", () => {
  assert.throws(() => readConfig({ IM_LIVE_TURN_TIMEOUT_MS: "soon" }), /positive integer/)
  assert.throws(() => readConfig({ IM_LIVE_DUPLICATE_WINDOW_MS: "0" }), /positive integer/)
  assert.throws(() => readConfig({ IM_LIVE_LOCK_TTL_MS: "-1" }), /positive integer/)
})

test("registerConfigSecrets hands every secret to the redactor", () => {
  const config = readConfig({ ...envForAll(), IM_LIVE_FIXTURE_TOKEN: "fixture-token-value" })
  const redactor = registerConfigSecrets(config, createRedactor())
  assert.ok(redactor.labels.includes("telegram.driverBotToken"))
  assert.ok(redactor.labels.includes("slack.driverUserToken"))
  assert.ok(redactor.labels.includes("discord.driverBotToken"))
  assert.ok(redactor.labels.includes("lark.driverAppSecret"))
  assert.ok(redactor.labels.includes("matrix.driverAccessToken"))
  assert.ok(redactor.labels.includes("fixtureToken"))
  assert.equal(
    redactor.redactString("boom: value-for-IM_LIVE_MATRIX_DRIVER_ACCESS_TOKEN"),
    "boom: «matrix.driverAccessToken»"
  )
})

test("selectPlatforms refuses a partial `all` run unless it is opted into", () => {
  const config = readConfig(envFor("telegram"))
  assert.throws(() => selectPlatforms(config, { platform: "all" }), /not configured/)
  const relaxed = selectPlatforms(config, { platform: "all", allowUnconfigured: true })
  assert.deepEqual(relaxed.requested, PLATFORMS)
  assert.deepEqual(relaxed.unconfigured, ["slack", "discord", "lark", "matrix"])
})

test("selectPlatforms names the missing variables in its error", () => {
  const config = readConfig({})
  assert.throws(
    () => selectPlatforms(config, { platform: "slack" }),
    /IM_LIVE_SLACK_DRIVER_USER_TOKEN/
  )
})

test("selectPlatforms rejects an unknown platform", () => {
  assert.throws(() => selectPlatforms(readConfig({}), { platform: "wecom" }), /unknown platform/)
})

test("selectPlatforms accepts a single fully-configured platform", () => {
  const config = readConfig(envFor("lark"))
  assert.deepEqual(selectPlatforms(config, { platform: "lark" }).requested, ["lark"])
})

test("loadImLiveEnv treats an absent file as fine and a broken one as fatal", () => {
  const enoent = Object.assign(new Error("nope"), { code: "ENOENT" })
  assert.deepEqual(
    loadImLiveEnv("missing.env", {
      loader: () => {
        throw enoent
      },
    }),
    { loaded: false, path: "missing.env" }
  )
  assert.deepEqual(loadImLiveEnv("ok.env", { loader: () => {} }), { loaded: true, path: "ok.env" })
  assert.throws(
    () =>
      loadImLiveEnv("bad.env", {
        loader: () => {
          throw new Error("unexpected token")
        },
      }),
    /failed to read bad\.env/
  )
})
