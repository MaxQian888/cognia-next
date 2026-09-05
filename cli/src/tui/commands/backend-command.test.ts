/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { backendChoices, backendCommand, backendHint, BUILTIN_BACKEND_ID } from "./backend-command"
import type { CommandContext } from "./types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

function run(args: string, overrides: Partial<ResolvedConfig> = {}) {
  // The root handler is optional on the descriptor type; this command always has
  // one, so assert it rather than guard on every call.
  return backendCommand.handler!({
    args,
    config: { ...config, ...overrides },
    version: "9.9.9",
  } as CommandContext)
}

describe("backendChoices", () => {
  it("offers the built-in agent first, then the executable presets", () => {
    expect(backendChoices(["codex", "claude-code"])).toEqual([
      BUILTIN_BACKEND_ID,
      "codex",
      "claude-code",
    ])
  })

  it("reads the real preset list by default", () => {
    const choices = backendChoices()
    expect(choices[0]).toBe(BUILTIN_BACKEND_ID)
    expect(choices).toContain("claude-code")
    expect(choices).toContain("codex-acp")
  })

  it("omits a preset that spawns no process", () => {
    // `opencode-remote` connects to an already-running server (no `process`), so
    // it would die at the connect's command stage — offering it promises a
    // backend the picker can't bring up.
    expect(backendChoices()).not.toContain("opencode-remote")
    // A preset given without a spawnable command is filtered even when passed in.
    expect(backendChoices(["codex", "opencode-remote"])).toEqual([BUILTIN_BACKEND_ID, "codex"])
  })
})

describe("/backend", () => {
  it("opens a picker with the current backend preselected", () => {
    const effect = run("", { agentBackend: "claude-code" })
    expect(effect.kind).toBe("openOverlay")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "select") {
      expect(effect.overlay.title).toBe("Agent backend")
      expect(effect.overlay.items[effect.overlay.index].id).toBe("claude-code")
      expect(effect.overlay.items[effect.overlay.index].hint).toMatch(/^current —/)
      // Re-dispatches through the same command, like /layout and /mascot.
      expect(effect.overlay.onSelectCommand).toBe("backend")
    }
  })

  it("preselects the built-in agent when none is configured", () => {
    const effect = run("")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "select") {
      expect(effect.overlay.items[effect.overlay.index].id).toBe(BUILTIN_BACKEND_ID)
    }
  })

  it("switches to a known backend", () => {
    expect(run("codex")).toEqual({ kind: "backend", backend: "codex" })
    expect(run("codex-acp")).toEqual({ kind: "backend", backend: "codex-acp" })
    expect(run("  CLAUDE-CODE  ")).toEqual({ kind: "backend", backend: "claude-code" })
  })

  it("rejects an unknown id and lists the real choices", () => {
    const effect = run("cdoex")
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") {
      expect(effect.message).toContain('Unknown backend "cdoex"')
      expect(effect.message).toContain(BUILTIN_BACKEND_ID)
    }
  })

  it("gives every choice a hint, falling back for presets with no blurb", () => {
    expect(backendHint("builtin", "codex")).toContain("Cognia's own agent")
    // A preset with no CLI credential injection says so, so the user isn't
    // surprised by a "not logged in" failure after selecting it.
    expect(backendHint("opencode", "codex")).toBe("external agent — log in with its own CLI first")
    // Codex/Claude-Code get their credentials injected, so no login note.
    expect(backendHint("codex", "codex")).toBe("current — host the Codex CLI")
    expect(backendHint("codex-acp", "codex-acp")).toBe("current — host Codex explicitly over ACP")
    expect(backendHint("opencode", "opencode")).toBe(
      "current — external agent — log in with its own CLI first"
    )

    // …and the picker actually uses it, so no row ever renders blank.
    const effect = run("")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "select") {
      for (const item of effect.overlay.items) expect(item.hint).toBeTruthy()
    }
  })

  it("does not restart the agent it is already on", () => {
    // Switching is destructive to the session, so a no-op request must stay one.
    expect(run("codex", { agentBackend: "codex" })).toEqual({
      kind: "notice",
      message: "Already on codex.",
    })
    expect(run("builtin")).toEqual({ kind: "notice", message: "Already on builtin." })
  })
})
