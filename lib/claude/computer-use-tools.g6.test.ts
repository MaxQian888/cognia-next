/**
 * Tests for the G6 IM blacklist gate on applyComputerUseTools.
 */

import { applyComputerUseTools } from "./computer-use-tools"
import type { Character, SendOptions } from "./types"

jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => {
  return {
    __esModule: true,
    listNativeAnthropicToolEntries: jest.fn(() => [
      {
        id: "anthropic.computer",
        entry: {
          name: "computer",
          type: "computer_20241022",
          betaHeader: "computer-use-2024-10-22",
          displayWidthPx: 1280,
          displayHeightPx: 720,
          executeIpc: "automation_computer",
        },
      },
    ]),
    computeAnthropicBetaHeaders: jest.fn(() => ["computer-use-2024-10-22"]),
  }
})

const baseChar: Character = {
  id: "c1",
  name: "Test",
  systemPrompt: "",
  enableComputerUse: true,
} as unknown as Character

function emptyOpts(): SendOptions {
  return {} as SendOptions
}

describe("applyComputerUseTools — G6 IM blacklist", () => {
  it("attaches tools normally for a browser-side chat session", () => {
    const result = applyComputerUseTools({ character: baseChar, opts: emptyOpts() })
    expect(result.attachedCount).toBe(1)
  })

  it("short-circuits for IM session without explicit per-conversation opt-in", () => {
    const result = applyComputerUseTools({
      character: baseChar,
      opts: emptyOpts(),
      imSession: true,
    })
    expect(result.attachedCount).toBe(0)
    expect(result.opts.anthropicTools).toBeUndefined()
  })

  it("re-attaches when the conversation opts in via allowImComputerUse=true", () => {
    const result = applyComputerUseTools({
      character: baseChar,
      opts: emptyOpts(),
      imSession: true,
      allowImComputerUse: true,
    })
    expect(result.attachedCount).toBe(1)
  })

  it("character.enableComputerUse=false still short-circuits even with allowImComputerUse=true", () => {
    const char = { ...baseChar, enableComputerUse: false }
    const result = applyComputerUseTools({
      character: char,
      opts: emptyOpts(),
      imSession: true,
      allowImComputerUse: true,
    })
    expect(result.attachedCount).toBe(0)
  })
})
