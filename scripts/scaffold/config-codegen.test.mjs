import { test } from "node:test"
import assert from "node:assert/strict"

import {
  tsTypeForProperty,
  pyTypeForProperty,
  generateTsConfig,
  generatePyConfig,
  generateConfigArtifacts,
} from "./config-codegen.mjs"

test("tsTypeForProperty maps scalar, enum, array, and object props", () => {
  assert.equal(tsTypeForProperty({ type: "string" }), "string")
  assert.equal(tsTypeForProperty({ type: "number" }), "number")
  assert.equal(tsTypeForProperty({ type: "boolean" }), "boolean")
  assert.equal(tsTypeForProperty({ type: "string", enum: ["a", "b"] }), '"a" | "b"')
  assert.equal(tsTypeForProperty({ type: "array", items: { type: "number" } }), "number[]")
  assert.equal(tsTypeForProperty({ type: "array" }), "unknown[]")
  assert.equal(
    tsTypeForProperty({ type: "object", properties: { x: { type: "string" } } }),
    "{ x: string }"
  )
  assert.equal(tsTypeForProperty({ type: "object" }), "Record<string, unknown>")
  assert.equal(tsTypeForProperty(null), "unknown")
})

test("pyTypeForProperty maps scalar, enum, and array props", () => {
  assert.equal(pyTypeForProperty({ type: "string" }), "str")
  assert.equal(pyTypeForProperty({ type: "number" }), "float")
  assert.equal(pyTypeForProperty({ type: "boolean" }), "bool")
  assert.equal(pyTypeForProperty({ type: "string", enum: ["a", "b"] }), 'Literal["a", "b"]')
  assert.equal(pyTypeForProperty({ type: "array", items: { type: "string" } }), "List[str]")
  assert.equal(pyTypeForProperty({ type: "object" }), "Dict[str, Any]")
  assert.equal(pyTypeForProperty(undefined), "Any")
})

const SCHEMA = {
  type: "object",
  required: ["apiKey"],
  properties: {
    apiKey: { type: "string", description: "API key" },
    shout: { type: "boolean", default: false },
    mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
  },
}

test("generateTsConfig emits a typed interface, helper, and defaults", () => {
  const out = generateTsConfig(SCHEMA)
  assert.match(out, /export interface PluginConfig \{/)
  assert.match(out, /\/\*\* API key \*\//)
  assert.match(out, /apiKey: string/) // required → no `?`
  assert.match(out, /shout\?: boolean/) // optional → `?`
  assert.match(out, /mode\?: "fast" \| "slow"/)
  assert.match(out, /export function asPluginConfig\(/)
  assert.match(out, /"shout": false/)
  assert.match(out, /"mode": "fast"/)
})

test("generateTsConfig handles an empty schema", () => {
  const out = generateTsConfig(undefined)
  assert.match(out, /export type PluginConfig = Record<string, never>/)
  assert.match(out, /CONFIG_DEFAULTS: Partial<PluginConfig> = \{\}/)
})

test("generatePyConfig emits a split required/optional TypedDict", () => {
  const out = generatePyConfig(SCHEMA)
  assert.match(out, /from typing import Any, Dict, List, Literal, TypedDict/)
  assert.match(out, /class _PluginConfigRequired\(TypedDict\):/)
  assert.match(out, /    apiKey: str/)
  assert.match(out, /class PluginConfig\(_PluginConfigRequired, total=False\):/)
  assert.match(out, /    shout: bool/)
  assert.match(out, /    mode: Literal\["fast", "slow"\]/)
  assert.match(out, /def as_plugin_config\(/)
  assert.match(out, /"mode": "fast"/)
})

test("generatePyConfig handles all-required and empty schemas", () => {
  const allReq = generatePyConfig({
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" } },
  })
  assert.match(allReq, /class PluginConfig\(TypedDict\):/)
  assert.match(allReq, /    a: float/)

  const empty = generatePyConfig({ type: "object", properties: {} })
  assert.match(empty, /class PluginConfig\(TypedDict, total=False\):\n    pass/)
})

test("generatePyConfig handles all-optional schema", () => {
  const out = generatePyConfig({
    type: "object",
    properties: { x: { type: "string" } },
  })
  assert.match(out, /class PluginConfig\(TypedDict, total=False\):/)
  assert.match(out, /    x: str/)
  assert.doesNotMatch(out, /_PluginConfigRequired/)
})

test("generateConfigArtifacts picks the file by plugin type", () => {
  const ts = generateConfigArtifacts({ type: "frontend", configSchema: SCHEMA })
  assert.deepEqual(Object.keys(ts), ["config.generated.ts"])

  const py = generateConfigArtifacts({ type: "python", configSchema: SCHEMA })
  assert.deepEqual(Object.keys(py), ["config_generated.py"])
})
