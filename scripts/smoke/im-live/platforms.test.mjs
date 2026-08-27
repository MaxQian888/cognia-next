// The platform list is shared by the config table, the driver registry and the
// docs gate, and none of them owns it — so a platform added to one and not the
// others shows up here rather than as a driver that silently never runs.

import assert from "node:assert/strict"
import test from "node:test"

import { DRIVER_FACTORIES } from "./drivers/index.mjs"
import { PLATFORMS } from "./platforms.mjs"

test("every platform has a driver, and every driver a platform", () => {
  assert.deepEqual([...PLATFORMS].sort(), Object.keys(DRIVER_FACTORIES).sort())
})

test("the reported order is fixed", () => {
  // Results are printed in this order, and the report fixtures assume it.
  assert.deepEqual(PLATFORMS, ["telegram", "slack", "discord", "lark", "matrix"])
})

test("the list has no duplicates", () => {
  assert.equal(new Set(PLATFORMS).size, PLATFORMS.length)
})
