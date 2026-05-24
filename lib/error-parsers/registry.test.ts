/**
 * @jest-environment node
 */

import { registerDefaultPreset, registerToolPreset, resolvePreset } from "./registry"
import type { ErrorPreset } from "./types"

const identityPreset: ErrorPreset = {
  name: "identity",
  parsers: [],
  parse(text: string) {
    return { nodes: [{ kind: "text" as const, content: text }], parsed: false }
  },
}

const customPreset: ErrorPreset = {
  name: "custom",
  parsers: [],
  parse(text: string) {
    return { nodes: [{ kind: "text" as const, content: `custom:${text}` }], parsed: true }
  },
}

beforeEach(() => {
  // Reset registry state before each test
  registerDefaultPreset(identityPreset)
})

describe("registry", () => {
  it("resolves the default preset when no tool override exists", () => {
    const preset = resolvePreset()
    expect(preset.name).toBe("identity")
    const result = preset.parse("hello")
    expect(result.parsed).toBe(false)
    expect(result.nodes[0].content).toBe("hello")
  })

  it("resolves a tool-specific override", () => {
    registerToolPreset("bash", customPreset)
    const preset = resolvePreset("bash")
    expect(preset.name).toBe("custom")
    const result = preset.parse("hello")
    expect(result.parsed).toBe(true)
    expect(result.nodes[0].content).toBe("custom:hello")
  })

  it("falls back to default when tool override does not exist", () => {
    const preset = resolvePreset("nonexistent-tool")
    expect(preset.name).toBe("identity")
  })

  it("last registration wins for duplicate tool presets", () => {
    const newerPreset: ErrorPreset = {
      name: "newer",
      parsers: [],
      parse(text: string) {
        return { nodes: [{ kind: "text" as const, content: `newer:${text}` }], parsed: true }
      },
    }
    registerToolPreset("bash", customPreset)
    registerToolPreset("bash", newerPreset)
    const preset = resolvePreset("bash")
    expect(preset.name).toBe("newer")
  })
})
