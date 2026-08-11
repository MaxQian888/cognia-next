import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createRpcAuditStore } from "./observability"

describe("createRpcAuditStore", () => {
  it("persists bounded, payload-free audit rows and exports trace projections", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cognia-rpc-audit-"))
    try {
      const store = createRpcAuditStore(home)
      store.append({
        id: "request-1",
        at: "2026-08-11T00:00:00.000Z",
        method: "turn/run",
        sessionId: "session-1",
        durationMs: 12,
        result: "ok",
      })
      store.append({
        id: "request-2",
        at: "2026-08-11T00:00:01.000Z",
        method: "session/state",
        sessionId: "session-1",
        durationMs: 1,
        result: "error",
        errorCode: "session_not_found",
      })

      expect(store.query({ sessionId: "session-1", limit: 1 })).toEqual({
        entries: [expect.objectContaining({ id: "request-1", method: "turn/run" })],
        nextCursor: "request-1",
      })
      expect(store.exportTrace("session-1").spans).toEqual([
        expect.objectContaining({ name: "agent.rpc.turn/run", status: "ok" }),
        expect.objectContaining({ name: "agent.rpc.session/state", status: "error" }),
      ])
      expect(readFileSync(path.join(home, "agent-sdk", "audit.jsonl"), "utf8")).not.toContain(
        "prompt"
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
