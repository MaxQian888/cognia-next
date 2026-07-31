import {
  ALL_WRITABLE_AGENT_IDS,
  projectMcpToAllAgents,
  summarizeSyncResult,
} from "./sync-projection"
import type { AgentId } from "@cognia/agent-config-types"

describe("sync-projection", () => {
  it("lists the writable agents in adapter order (cognia CLI first)", () => {
    expect(ALL_WRITABLE_AGENT_IDS).toEqual([
      "cognia",
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
      "codex",
      "gemini",
      "windsurf",
    ])
  })

  describe("summarizeSyncResult", () => {
    it("captures success with count", () => {
      const out = summarizeSyncResult("claude-code", {
        ok: true,
        result: { ok: true, written: 0 } as never,
        count: 3,
      })
      expect(out).toEqual({ agentId: "claude-code", ok: true, count: 3 })
    })

    it("captures skipped reason", () => {
      const out = summarizeSyncResult("vscode", {
        ok: false,
        skipped: true,
        reason: "agent-not-installed",
      })
      expect(out).toEqual({
        agentId: "vscode",
        ok: false,
        reason: "agent-not-installed",
      })
    })

    it("captures hard error reason", () => {
      const out = summarizeSyncResult("cursor", {
        ok: false,
        skipped: false,
        error: "EACCES",
      })
      expect(out).toEqual({ agentId: "cursor", ok: false, reason: "EACCES" })
    })
  })

  describe("projectMcpToAllAgents", () => {
    it("returns 'not-tauri' for every agent when not running in Tauri", async () => {
      const out = await projectMcpToAllAgents({
        isTauri: () => false,
        agentIds: ["claude-code", "cursor"],
      })
      expect(out).toEqual([
        { agentId: "claude-code", ok: false, reason: "not-tauri" },
        { agentId: "cursor", ok: false, reason: "not-tauri" },
      ])
    })

    it("aggregates per-agent results in Tauri", async () => {
      const sync = jest.fn(async (id: AgentId) => {
        if (id === "claude-code") {
          return { ok: true as const, result: {} as never, count: 2 }
        }
        if (id === "cursor") {
          return {
            ok: false as const,
            skipped: true as const,
            reason: "agent-not-installed" as const,
          }
        }
        return { ok: false as const, skipped: false as const, error: "boom" }
      })
      const out = await projectMcpToAllAgents({
        isTauri: () => true,
        agentIds: ["claude-code", "cursor", "vscode"],
        syncToAgent: sync,
      })
      expect(sync).toHaveBeenCalledTimes(3)
      expect(out).toEqual([
        { agentId: "claude-code", ok: true, count: 2 },
        { agentId: "cursor", ok: false, reason: "agent-not-installed" },
        { agentId: "vscode", ok: false, reason: "boom" },
      ])
    })

    it("converts a thrown promise rejection into a per-agent error", async () => {
      const sync = jest.fn(async (id: AgentId) => {
        if (id === "claude-code") throw new Error("locked")
        if (id === "cursor") throw "string-reject"
        return { ok: true as const, result: {} as never, count: 0 }
      })
      const out = await projectMcpToAllAgents({
        isTauri: () => true,
        agentIds: ["claude-code", "cursor", "vscode"],
        syncToAgent: sync,
      })
      expect(out[0]).toEqual({ agentId: "claude-code", ok: false, reason: "locked" })
      expect(out[1]).toEqual({ agentId: "cursor", ok: false, reason: "string-reject" })
      expect(out[2]).toEqual({ agentId: "vscode", ok: true, count: 0 })
    })
  })
})
