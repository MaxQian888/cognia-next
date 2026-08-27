// Configuration for the live IM harness.
//
// Everything comes from the environment — never from a checked-in file, never
// from the app's Dexie/keyring state. `.env.im-live.local` is read only as a
// convenience for local runs; `.gitignore` already covers `.env*`.
//
// Every field names its own environment variable explicitly instead of being
// derived from a prefix. That is what keeps the five platforms isolated: a
// Slack credential cannot become a Telegram credential through a typo in a
// prefix computation, and the table below doubles as the documented contract.

import { PLATFORMS } from "./platforms.mjs"

export { PLATFORMS }

/**
 * Per-platform fields.
 *
 * `secret: true` fields are registered with the redactor before anything is
 * printed. `optional` fields never make a platform NOT_CONFIGURED.
 */
export const PLATFORM_FIELDS = {
  telegram: {
    driverBotToken: { env: "IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN", secret: true },
    targetChatId: { env: "IM_LIVE_TELEGRAM_TARGET_CHAT_ID" },
    targetBotUsername: { env: "IM_LIVE_TELEGRAM_TARGET_BOT_USERNAME" },
    // Test DC / self-hosted Bot API server. Default is the public endpoint.
    apiBase: {
      env: "IM_LIVE_TELEGRAM_API_BASE",
      optional: true,
      default: "https://api.telegram.org",
    },
  },
  slack: {
    // A USER token, not a bot token: `lib/connectors/adapters/slack/parse.ts`
    // drops every event carrying `bot_id`, so a second bot can never reach the
    // target. See the Local Live Testing doc.
    driverUserToken: { env: "IM_LIVE_SLACK_DRIVER_USER_TOKEN", secret: true },
    targetChannelId: { env: "IM_LIVE_SLACK_TARGET_CHANNEL_ID" },
    targetBotUserId: { env: "IM_LIVE_SLACK_TARGET_BOT_USER_ID" },
    apiBase: { env: "IM_LIVE_SLACK_API_BASE", optional: true, default: "https://slack.com/api" },
  },
  discord: {
    driverBotToken: { env: "IM_LIVE_DISCORD_DRIVER_BOT_TOKEN", secret: true },
    targetChannelId: { env: "IM_LIVE_DISCORD_TARGET_CHANNEL_ID" },
    targetBotUserId: { env: "IM_LIVE_DISCORD_TARGET_BOT_USER_ID" },
    apiBase: {
      env: "IM_LIVE_DISCORD_API_BASE",
      optional: true,
      default: "https://discord.com/api/v10",
    },
  },
  lark: {
    driverAppId: { env: "IM_LIVE_LARK_DRIVER_APP_ID" },
    driverAppSecret: { env: "IM_LIVE_LARK_DRIVER_APP_SECRET", secret: true },
    targetChatId: { env: "IM_LIVE_LARK_TARGET_CHAT_ID" },
    targetBotOpenId: { env: "IM_LIVE_LARK_TARGET_BOT_OPEN_ID" },
    apiBase: {
      env: "IM_LIVE_LARK_API_BASE",
      optional: true,
      default: "https://open.feishu.cn/open-apis",
    },
  },
  matrix: {
    homeserver: { env: "IM_LIVE_MATRIX_HOMESERVER" },
    driverAccessToken: { env: "IM_LIVE_MATRIX_DRIVER_ACCESS_TOKEN", secret: true },
    targetRoomId: { env: "IM_LIVE_MATRIX_TARGET_ROOM_ID" },
    targetUserId: { env: "IM_LIVE_MATRIX_TARGET_USER_ID" },
  },
}

/** Where the runner looks for the fixture handshake `pnpm im:test:target` wrote. */
export const DEFAULT_OUTPUT_DIR = "test-results/im-live"

const DEFAULTS = {
  turnTimeoutMs: { env: "IM_LIVE_TURN_TIMEOUT_MS", value: 120_000 },
  duplicateWindowMs: { env: "IM_LIVE_DUPLICATE_WINDOW_MS", value: 10_000 },
  lockTtlMs: { env: "IM_LIVE_LOCK_TTL_MS", value: 30 * 60 * 1000 },
}

/**
 * Read `.env.im-live.local` into `process.env` if it exists.
 *
 * Absent file is not an error — CI and one-off runs pass the variables
 * inline. A malformed file IS an error: silently continuing would report
 * every platform as NOT_CONFIGURED and send the operator hunting for the
 * wrong problem.
 */
export function loadImLiveEnv(path = ".env.im-live.local", { loader = process.loadEnvFile } = {}) {
  try {
    loader(path)
    return { loaded: true, path }
  } catch (error) {
    if (error?.code === "ENOENT") return { loaded: false, path }
    throw new Error(`failed to read ${path}: ${error?.message ?? error}`)
  }
}

function readPositiveInt(env, spec) {
  const raw = env[spec.env]
  if (raw === undefined || raw === "") return spec.value
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${spec.env} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

/** One platform's slice. Never reads any other platform's variables. */
function readPlatform(platform, env) {
  const fields = PLATFORM_FIELDS[platform]
  const values = {}
  const missing = []
  const secrets = []
  for (const [name, spec] of Object.entries(fields)) {
    const raw = env[spec.env]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value === "") {
      if (spec.optional) values[name] = spec.default
      else missing.push(spec.env)
      continue
    }
    values[name] = value
    if (spec.secret) secrets.push({ value, label: `${platform}.${name}` })
  }
  return {
    platform,
    status: missing.length === 0 ? "configured" : "not_configured",
    missing,
    values,
    secrets,
  }
}

/**
 * Build the whole config.
 *
 * Takes `env` explicitly so tests can prove isolation without touching the
 * ambient process environment.
 */
export function readConfig(env = process.env) {
  const platforms = {}
  for (const platform of PLATFORMS) platforms[platform] = readPlatform(platform, env)
  return {
    platforms,
    turnTimeoutMs: readPositiveInt(env, DEFAULTS.turnTimeoutMs),
    duplicateWindowMs: readPositiveInt(env, DEFAULTS.duplicateWindowMs),
    lockTtlMs: readPositiveInt(env, DEFAULTS.lockTtlMs),
    // Cleanup is the default; `IM_LIVE_KEEP=1` retains the messages so an
    // operator can inspect a failure in the real conversation.
    cleanup: env.IM_LIVE_KEEP !== "1",
    outputDir: env.IM_LIVE_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
    fixtureUrl: env.IM_LIVE_FIXTURE_URL?.trim() || "",
    fixtureToken: env.IM_LIVE_FIXTURE_TOKEN?.trim() || "",
  }
}

/** Register every secret from every configured platform with a redactor. */
export function registerConfigSecrets(config, redactor) {
  for (const platform of PLATFORMS) {
    for (const { value, label } of config.platforms[platform].secrets) {
      redactor.register(value, label)
    }
  }
  if (config.fixtureToken) redactor.register(config.fixtureToken, "fixtureToken")
  return redactor
}

/**
 * Which platforms this invocation should run.
 *
 * `--platform all` requires every platform to be configured. A partial run
 * that silently reports four greens and one absence reads as "IM works",
 * which is the failure mode this harness exists to prevent — so opting into
 * it takes an explicit `--allow-unconfigured`.
 */
export function selectPlatforms(config, { platform = "all", allowUnconfigured = false } = {}) {
  const requested = platform === "all" ? [...PLATFORMS] : [platform]
  for (const name of requested) {
    if (!PLATFORMS.includes(name)) {
      throw new Error(
        `unknown platform ${JSON.stringify(name)} (want one of: ${PLATFORMS.join(", ")})`
      )
    }
  }
  const unconfigured = requested.filter((name) => config.platforms[name].status !== "configured")
  if (unconfigured.length > 0 && !allowUnconfigured) {
    const detail = unconfigured
      .map((name) => `${name} (missing ${config.platforms[name].missing.join(", ")})`)
      .join("; ")
    throw new Error(
      `not configured: ${detail}. Set the variables in .env.im-live.local, ` +
        `or pass --allow-unconfigured to run the rest and report these as NOT_CONFIGURED.`
    )
  }
  return { requested, unconfigured }
}
