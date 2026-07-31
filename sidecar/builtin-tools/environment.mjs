// Environment tools — list_env, get_env, system_info.
//
// All read-only, low-risk. Secret-shaped keys (KEY/TOKEN/SECRET/PASSWORD/
// CREDENTIAL) are redacted by default; the caller can pass
// `revealSecrets: true` to bypass redaction, but that flag itself is gated
// by the per-call approval flow at the parent.

import os from "node:os"
import process from "node:process"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "./safety.mjs"

const SECRET_RE = /(key|secret|token|password|credential|passwd|api[_-]?key)/i

/**
 * Decide whether a value should be redacted.
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  if (typeof key !== "string") return false
  return SECRET_RE.test(key)
}

/**
 * Hide secret values from the agent. Returns a string of the same length
 * with eight asterisks (so length isn't a side channel for guessing).
 */
function redactValue() {
  return "********"
}

// ---- list_env -------------------------------------------------------------

const listEnvShape = {
  prefix: z
    .string()
    .optional()
    .describe("Filter to env keys starting with this prefix (case-insensitive)."),
  revealSecrets: z
    .boolean()
    .default(false)
    .describe(
      "When true, return values for keys that look like secrets. Defaults to false; flagged for approval at the parent."
    ),
}

async function execListEnv(args) {
  try {
    const entries = Object.entries(process.env)
    const lower = args.prefix?.toLowerCase()
    const filtered = lower ? entries.filter(([k]) => k.toLowerCase().startsWith(lower)) : entries
    const out = filtered.map(([key, value]) => ({
      key,
      value: isSecretKey(key) && !args.revealSecrets ? redactValue() : (value ?? ""),
      redacted: isSecretKey(key) && !args.revealSecrets,
    }))
    return toolText({ count: out.length, env: out })
  } catch (err) {
    return toolError(err, "list_env")
  }
}

export const listEnvTool = tool(
  "list_env",
  "List process environment variables (read-only). Secret-shaped keys are redacted unless revealSecrets=true.",
  listEnvShape,
  execListEnv,
  { alwaysLoad: true }
)

// ---- get_env --------------------------------------------------------------

const getEnvShape = {
  key: z.string().min(1).describe("Environment variable name."),
  revealSecrets: z
    .boolean()
    .default(false)
    .describe("Return the literal value even if the key looks secret."),
}

async function execGetEnv(args) {
  try {
    const value = process.env[args.key]
    if (value === undefined) {
      return toolText({ key: args.key, set: false })
    }
    const redacted = isSecretKey(args.key) && !args.revealSecrets
    return toolText({
      key: args.key,
      set: true,
      value: redacted ? redactValue() : value,
      redacted,
    })
  } catch (err) {
    return toolError(err, "get_env")
  }
}

export const getEnvTool = tool(
  "get_env",
  "Read a single environment variable. Returns set:false when the key is undefined.",
  getEnvShape,
  execGetEnv,
  { alwaysLoad: true }
)

// ---- system_info ----------------------------------------------------------

const systemInfoShape = {}

async function execSystemInfo() {
  try {
    return toolText({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? null,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      release: os.release(),
      type: os.type(),
      tmpdir: os.tmpdir(),
      homedir: os.homedir(),
      userInfoUsername: safeUser(),
    })
  } catch (err) {
    return toolError(err, "system_info")
  }
}

function safeUser() {
  try {
    return os.userInfo().username
  } catch {
    return null
  }
}

export const systemInfoTool = tool(
  "system_info",
  "Report platform, architecture, node version, cpu, memory, hostname, uptime, etc.",
  systemInfoShape,
  execSystemInfo,
  { alwaysLoad: true }
)

// ---- current_time ---------------------------------------------------------

const currentTimeShape = {
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone for the `local` field (e.g. 'America/New_York', 'Asia/Shanghai'). Defaults to the host timezone. UTC fields are always returned regardless."
    ),
}

async function execCurrentTime(args) {
  try {
    const now = new Date()
    const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const timezone =
      typeof args.timezone === "string" && args.timezone.length > 0 ? args.timezone : systemTimeZone

    let local
    try {
      local = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZoneName: "short",
      }).format(now)
    } catch {
      return toolError(new Error(`Invalid timezone: ${args.timezone}`), "current_time")
    }

    return toolText({
      iso: now.toISOString(),
      utc: now.toUTCString(),
      epochMs: now.getTime(),
      epochSec: Math.floor(now.getTime() / 1000),
      timezone,
      local,
    })
  } catch (err) {
    return toolError(err, "current_time")
  }
}

export const currentTimeTool = tool(
  "current_time",
  "Get the current date and time. Returns UTC (iso/utc/epoch) plus a localized string for the given IANA timezone (defaults to the host timezone). Use this whenever you need to know the current time instead of guessing.",
  currentTimeShape,
  execCurrentTime,
  { alwaysLoad: true }
)

// ---- Exports --------------------------------------------------------------

export const environmentTools = [listEnvTool, getEnvTool, systemInfoTool, currentTimeTool]

export const __testExports = {
  execListEnv,
  execGetEnv,
  execSystemInfo,
  execCurrentTime,
  isSecretKey,
  redactValue,
  safeUser,
}
