import type { FleetSession } from "./types"
import { mergeFleetSnapshots } from "./unified-fleet-store"

function session(agent: FleetSession["agent"], sessionId: string): FleetSession {
  return {
    agent,
    sessionId,
    status: "working",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: false,
    },
    startedAt: 1,
    lastEventAt: 2,
    toolUseCount: 0,
    turnCount: 0,
  }
}

describe("mergeFleetSnapshots", () => {
  it("combines external and canonical executions and labels legacy rows", () => {
    const canonical = new Map([["built-in", session("cognia", "built-in")]])
    const merged = mergeFleetSnapshots(
      { sessions: [session("codex", "external")], generatedAt: 10 },
      canonical,
      20
    )
    expect(merged.sessions.map(({ agent, origin }) => [agent, origin])).toEqual([
      ["codex", "external"],
      ["cognia", undefined],
    ])
    expect(merged.generatedAt).toBe(20)
  })
})
