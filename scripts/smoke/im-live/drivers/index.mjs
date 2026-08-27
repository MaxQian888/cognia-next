// Driver registry.
//
// One factory per platform, all implementing the same surface so `run.mjs` has
// no platform branches at all — the only place a platform's peculiarities live
// is its own module.

import { PLATFORMS } from "../platforms.mjs"
import { createDiscordDriver } from "./discord.mjs"
import { createLarkDriver } from "./lark.mjs"
import { createMatrixDriver } from "./matrix.mjs"
import { createSlackDriver } from "./slack.mjs"
import { createTelegramDriver } from "./telegram.mjs"

export const DRIVER_FACTORIES = Object.freeze({
  telegram: createTelegramDriver,
  slack: createSlackDriver,
  discord: createDiscordDriver,
  lark: createLarkDriver,
  matrix: createMatrixDriver,
})

/** Methods `run.mjs` and `doctor.mjs` rely on. */
export const DRIVER_SURFACE = Object.freeze([
  "doctor",
  "prepare",
  "injectMention",
  "replyToTarget",
  "pollTargetMessages",
  "cleanup",
])

export function createDriver(platform, options) {
  const factory = DRIVER_FACTORIES[platform]
  if (!factory) {
    throw new Error(`no driver for ${platform} (want one of: ${PLATFORMS.join(", ")})`)
  }
  return factory(options)
}
