/**
 * Tests for the G6 IM blacklist gate on applyComputerUseTools.
 */

import { applyComputerUseTools } from "./computer-use-tools"
import {
  getActiveComputerUseSettings,
  __resetForTesting as resetActiveComputerUseSettings,
} from "./computer-use-active-settings"
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

describe("applyComputerUseTools — W1 forceTier / consentMode plumbing", () => {
  it("requireConsent=true stamps forceTier:perCall on every attached tool", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { requireConsent: true },
    } as Character
    const result = applyComputerUseTools({ character: char, opts: emptyOpts() })
    expect(result.attachedCount).toBe(1)
    const tools = result.opts.anthropicTools
    expect(tools).toBeDefined()
    expect(tools![0].forceTier).toBe("perCall")
  })

  it("requireConsent unset omits forceTier so the wire shape stays tight", () => {
    const result = applyComputerUseTools({ character: baseChar, opts: emptyOpts() })
    const tools = result.opts.anthropicTools
    expect(tools).toBeDefined()
    expect(tools![0]).not.toHaveProperty("forceTier")
  })

  it("propagates chatConsentMode onto SendOptions.computerUseConsentMode", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { chatConsentMode: "session-grant" as const },
    } as Character
    const result = applyComputerUseTools({ character: char, opts: emptyOpts() })
    expect(result.opts.computerUseConsentMode).toBe("session-grant")
  })

  it("defaults chatConsentMode to always-ask when the character has no setting", () => {
    const result = applyComputerUseTools({ character: baseChar, opts: emptyOpts() })
    expect(result.opts.computerUseConsentMode).toBe("always-ask")
  })

  it("does not stamp consentMode when enableComputerUse is false (short-circuit case)", () => {
    const char = { ...baseChar, enableComputerUse: false }
    const result = applyComputerUseTools({ character: char, opts: emptyOpts() })
    expect(result.attachedCount).toBe(0)
    expect(result.opts.computerUseConsentMode).toBeUndefined()
  })
})

describe("applyComputerUseTools — auto chatConsentMode (audit fix)", () => {
  it("auto + computerUseGateTier=perCall suppresses every plugin tool's chat modal", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { chatConsentMode: "auto" as const },
    } as Character
    const result = applyComputerUseTools({
      character: char,
      opts: emptyOpts(),
      sessionId: "sess-auto-1",
      computerUseGateTier: "perCall",
    })
    expect(result.opts.suppressApprovalForTools).toEqual(
      expect.arrayContaining([
        "computer_use",
        "bash",
        "text_editor",
        "mcp__cognia-plugin-tools__computer_use",
        "mcp__cognia-plugin-tools__bash",
        "mcp__cognia-plugin-tools__text_editor",
      ])
    )
  })

  it("auto + computerUseGateTier=whitelist leaves the chat modal in charge", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { chatConsentMode: "auto" as const },
    } as Character
    const result = applyComputerUseTools({
      character: char,
      opts: emptyOpts(),
      sessionId: "sess-auto-2",
      computerUseGateTier: "whitelist",
    })
    // Whitelist means the Rust gate pre-approves silently; the chat
    // modal is the only prompt the operator can see, so don't suppress.
    expect(result.opts.suppressApprovalForTools).toBeUndefined()
  })

  it("auto without a known computerUseGateTier degrades safely to always-ask", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { chatConsentMode: "auto" as const },
    } as Character
    const result = applyComputerUseTools({
      character: char,
      opts: emptyOpts(),
      sessionId: "sess-auto-3",
    })
    expect(result.opts.suppressApprovalForTools).toBeUndefined()
  })
})

describe("applyComputerUseTools — active-settings cache (audit fix)", () => {
  // The chat-path plugin executor reads the active character's settings
  // via `getActiveComputerUseSettings(sessionId)`. Verify the write
  // side: applyComputerUseTools stashes the settings keyed by session
  // id when `enableComputerUse === true` and clears them otherwise.
  // Without this the Wave 1 `requireConsent` field was effectively a
  // no-op on the chat path (it lived on `opts.anthropicTools[]` which
  // the Claude Code SDK ignores).
  beforeEach(() => resetActiveComputerUseSettings())

  it("stashes computerUseSettings under the session id when enableComputerUse is on", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { requireConsent: true, chatConsentMode: "session-grant" as const },
    } as Character
    applyComputerUseTools({ character: char, opts: emptyOpts(), sessionId: "sess-1" })
    const cached = getActiveComputerUseSettings("sess-1")
    expect(cached).not.toBeNull()
    expect(cached!.requireConsent).toBe(true)
    expect(cached!.chatConsentMode).toBe("session-grant")
  })

  it("clears the cache when the character flips enableComputerUse off mid-session", () => {
    const charOn = {
      ...baseChar,
      computerUseSettings: { requireConsent: true },
    } as Character
    applyComputerUseTools({ character: charOn, opts: emptyOpts(), sessionId: "sess-2" })
    expect(getActiveComputerUseSettings("sess-2")).not.toBeNull()
    const charOff = { ...baseChar, enableComputerUse: false }
    applyComputerUseTools({ character: charOff, opts: emptyOpts(), sessionId: "sess-2" })
    expect(getActiveComputerUseSettings("sess-2")).toBeNull()
  })

  it("does not stash when sessionId is absent (workflow / MCP callers)", () => {
    const char = {
      ...baseChar,
      computerUseSettings: { requireConsent: true },
    } as Character
    applyComputerUseTools({ character: char, opts: emptyOpts() })
    // No sessionId means nothing to key on — the chat path is the
    // only consumer that needs the cache, so other callers stay clean.
    expect(getActiveComputerUseSettings("any")).toBeNull()
  })
})
