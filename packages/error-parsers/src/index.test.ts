/**
 * @jest-environment node
 */

import {
  resolvePreset,
  defaultPreset,
  jsonParser,
  logParser,
  stackTraceParser,
  pathUrlParser,
} from "./index"

describe("error-parsers index", () => {
  it("exports all public APIs", () => {
    expect(typeof resolvePreset).toBe("function")
    expect(defaultPreset).toBeDefined()
    expect(jsonParser).toBeDefined()
    expect(logParser).toBeDefined()
    expect(stackTraceParser).toBeDefined()
    expect(pathUrlParser).toBeDefined()
  })

  it("auto-registers the default preset", () => {
    const preset = resolvePreset()
    expect(preset.name).toBe("default")
  })
})
