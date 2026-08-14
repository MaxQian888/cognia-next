import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import {
  __testExports,
  listEnvTool,
  getEnvTool,
  systemInfoTool,
  currentTimeTool,
} from "../environment.mjs"

const {
  execListEnv,
  execGetEnv,
  execSystemInfo,
  execCurrentTime,
  isSecretKey,
  redactValue,
  safeUser,
} = __testExports

function decode(r) {
  return JSON.parse(r.content[0].text)
}

const SAVED = {}
function setEnv(k, v) {
  SAVED[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

before(() => {
  setEnv("COGNIA_TEST_PUBLIC", "hello")
  setEnv("COGNIA_TEST_SECRET_KEY", "super-secret-value-1234")
  setEnv("COGNIA_TEST_API_KEY", "ak-abcdef")
})
after(() => restoreEnv())

test("isSecretKey detects common secret patterns", () => {
  assert.equal(isSecretKey("API_KEY"), true)
  assert.equal(isSecretKey("api_key"), true)
  assert.equal(isSecretKey("MY_SECRET"), true)
  assert.equal(isSecretKey("TOKEN"), true)
  assert.equal(isSecretKey("DB_PASSWORD"), true)
  assert.equal(isSecretKey("CREDENTIALS_PATH"), true)
  assert.equal(isSecretKey("HOME"), false)
  assert.equal(isSecretKey("PATH"), false)
  assert.equal(isSecretKey(undefined), false)
})

test("redactValue returns a fixed-length placeholder", () => {
  assert.equal(redactValue(), "********")
})

test("safeUser returns a string or null", () => {
  const u = safeUser()
  if (u !== null) assert.equal(typeof u, "string")
})

test("list_env returns redacted values for secret-shaped keys", async () => {
  const r = await execListEnv({ prefix: "COGNIA_TEST_", revealSecrets: false })
  const data = decode(r)
  const byKey = Object.fromEntries(data.env.map((e) => [e.key, e]))
  assert.equal(byKey.COGNIA_TEST_PUBLIC.value, "hello")
  assert.equal(byKey.COGNIA_TEST_PUBLIC.redacted, false)
  assert.equal(byKey.COGNIA_TEST_SECRET_KEY.value, "********")
  assert.equal(byKey.COGNIA_TEST_SECRET_KEY.redacted, true)
  assert.equal(byKey.COGNIA_TEST_API_KEY.value, "********")
  assert.equal(byKey.COGNIA_TEST_API_KEY.redacted, true)
})

test("list_env cannot be made to reveal secrets", async () => {
  // `revealSecrets` was removed: it bypassed redaction on a tool declared
  // `requiresApproval: false`, so it was auto-allowed in plan mode, dontAsk and
  // headless. Passing it now has no effect — redaction is unconditional.
  const r = await execListEnv({ prefix: "COGNIA_TEST_SECRET_", revealSecrets: true })
  const data = decode(r)
  const e = data.env.find((x) => x.key === "COGNIA_TEST_SECRET_KEY")
  assert.equal(e.value, "********")
  assert.equal(e.redacted, true)
})

test("list_env without prefix returns the full env", async () => {
  const r = await execListEnv({ prefix: undefined, revealSecrets: false })
  const data = decode(r)
  assert.ok(data.count > 0)
})

test("get_env returns set:false for missing keys", async () => {
  const r = await execGetEnv({
    key: "COGNIA_DEFINITELY_NOT_SET_XYZ",
    revealSecrets: false,
  })
  assert.equal(decode(r).set, false)
})

test("get_env redacts a secret value by default", async () => {
  const r = await execGetEnv({ key: "COGNIA_TEST_SECRET_KEY", revealSecrets: false })
  const data = decode(r)
  assert.equal(data.set, true)
  assert.equal(data.value, "********")
  assert.equal(data.redacted, true)
})

test("get_env cannot be made to reveal a secret", async () => {
  const r = await execGetEnv({ key: "COGNIA_TEST_SECRET_KEY", revealSecrets: true })
  const data = decode(r)
  assert.equal(data.value, "********")
  assert.equal(data.redacted, true)
})

test("get_env returns plain value for non-secret keys", async () => {
  const r = await execGetEnv({ key: "COGNIA_TEST_PUBLIC", revealSecrets: false })
  const data = decode(r)
  assert.equal(data.value, "hello")
  assert.equal(data.redacted, false)
})

test("system_info returns platform + arch + cpu count", async () => {
  const r = await execSystemInfo()
  const data = decode(r)
  assert.equal(data.platform, process.platform)
  assert.equal(data.arch, process.arch)
  assert.ok(data.cpuCount >= 1)
  assert.ok(data.totalMemoryBytes > 0)
  assert.ok(typeof data.hostname === "string")
  assert.equal(data.cogniaTools.serverName, "cognia-tools")
  assert.match(data.cogniaTools.serverVersion, /^\d+\.\d+\.\d+$/)
  assert.equal(data.cogniaTools.pid, process.pid)
  assert.ok(!Number.isNaN(Date.parse(data.cogniaTools.startedAt)))
  assert.match(data.cogniaTools.runtimeFingerprint, /^cognia-tools@\d+\.\d+\.\d+:\d+:/)
  assert.equal(data.cogniaTools.health.status, "ok")
  assert.equal(data.cogniaTools.health.checks.stdio.ok, true)
  assert.equal(data.cogniaTools.health.checks.tempDirectory.ok, true)
  assert.equal(data.cogniaTools.health.checks.git.ok, true)
})

test("current_time returns UTC + epoch + localized fields", async () => {
  const r = await execCurrentTime({})
  const data = decode(r)
  assert.ok(!Number.isNaN(Date.parse(data.iso)))
  assert.ok(typeof data.utc === "string" && data.utc.length > 0)
  assert.equal(typeof data.epochMs, "number")
  assert.ok(data.epochMs > 0)
  assert.equal(data.epochSec, Math.floor(data.epochMs / 1000))
  assert.ok(typeof data.timezone === "string" && data.timezone.length > 0)
  assert.ok(typeof data.local === "string" && data.local.length > 0)
})

test("current_time honors an explicit IANA timezone", async () => {
  const r = await execCurrentTime({ timezone: "Asia/Shanghai" })
  const data = decode(r)
  assert.equal(data.timezone, "Asia/Shanghai")
  assert.ok(data.local.includes("GMT+8") || data.local.includes("CST") || data.local.length > 0)
})

test("current_time rejects an invalid timezone", async () => {
  const r = await execCurrentTime({ timezone: "Not/AReal_Zone" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Invalid timezone/i)
})

test("current_time falls back to host timezone for an empty string", async () => {
  const r = await execCurrentTime({ timezone: "" })
  const data = decode(r)
  assert.equal(data.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test("exported tool definitions have name + description", () => {
  for (const t of [listEnvTool, getEnvTool, systemInfoTool, currentTimeTool]) {
    assert.equal(typeof t.name, "string")
    assert.ok(t.name.length > 0)
    assert.ok(typeof t.description === "string" && t.description.length > 0)
  }
})
