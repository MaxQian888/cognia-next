import test from "node:test"
import assert from "node:assert/strict"

import { PLATFORMS } from "../platforms.mjs"
import { PLATFORM_FIELDS, readConfig } from "../config.mjs"
import { DRIVER_FACTORIES, DRIVER_SURFACE, createDriver } from "./index.mjs"

/** Placeholder values for every required field of a platform. */
function valuesFor(platform) {
  const env = {}
  for (const spec of Object.values(PLATFORM_FIELDS[platform])) {
    if (spec.optional) continue
    // Homeserver and API bases must parse as URLs for the driver to build one.
    env[spec.env] = /HOMESERVER|API_BASE/.test(spec.env) ? "http://127.0.0.1:1" : `x-${spec.env}`
  }
  return readConfig(env).platforms[platform].values
}

test("every platform in the list has a driver, and no driver is orphaned", () => {
  assert.deepEqual(Object.keys(DRIVER_FACTORIES).sort(), [...PLATFORMS].sort())
})

test("every driver implements the whole surface run.mjs depends on", () => {
  for (const platform of PLATFORMS) {
    const driver = createDriver(platform, { values: valuesFor(platform) })
    for (const method of DRIVER_SURFACE) {
      assert.equal(typeof driver[method], "function", `${platform}.${method}`)
    }
    assert.equal(driver.platform, platform)
    assert.equal(typeof driver.conversationId, "string")
    assert.ok(
      driver.conversationId.length > 0,
      `${platform} must expose a conversation id for the lock`
    )
  }
})

test("each driver's conversationId is the platform's own conversation field", () => {
  const expected = {
    telegram: "targetChatId",
    slack: "targetChannelId",
    discord: "targetChannelId",
    lark: "targetChatId",
    matrix: "targetRoomId",
  }
  for (const platform of PLATFORMS) {
    const values = valuesFor(platform)
    const driver = createDriver(platform, { values })
    assert.equal(driver.conversationId, String(values[expected[platform]]), platform)
  }
})

test("an unknown platform names the ones that exist", () => {
  assert.throws(() => createDriver("wecom", { values: {} }), /no driver for wecom/)
  assert.throws(
    () => createDriver("wecom", { values: {} }),
    /telegram, slack, discord, lark, matrix/
  )
})
