import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createDurableRpcStateStore } from "./durable-state"

describe("createDurableRpcStateStore", () => {
  it("atomically persists command receipts and unresolved actions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cognia-rpc-state-"))
    try {
      const store = createDurableRpcStateStore((sessionId) => path.join(root, sessionId))
      store.update("session-1", (state) => {
        state.commandResults["rename:command-1"] = { commandId: "command-1", accepted: true }
        state.pendingPermissions["permission-1"] = { requestId: "permission-1" }
        state.suspendedTurn = {
          prompt: "continue",
          params: { maxSteps: 10 },
          runId: "run-1",
          turnId: "turn-1",
          attempt: 0,
          permissionResponses: {},
          elicitationResponses: {},
          externalToolResponses: {},
        }
      })

      expect(store.read("session-1")).toMatchObject({
        commandResults: { "rename:command-1": { accepted: true } },
        pendingPermissions: { "permission-1": { requestId: "permission-1" } },
        suspendedTurn: { prompt: "continue", runId: "run-1", turnId: "turn-1" },
      })
      expect(readFileSync(path.join(root, "session-1", "rpc-state.json"), "utf8")).toMatch(
        /"schemaVersion":1/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed to an empty state for corrupt data", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cognia-rpc-state-"))
    try {
      const store = createDurableRpcStateStore((sessionId) => path.join(root, sessionId))
      expect(store.read("missing")).toEqual({
        schemaVersion: 1,
        tags: [],
        commandResults: {},
        pendingPermissions: {},
        pendingElicitations: {},
        pendingExternalTools: {},
        sandboxPolicy: null,
        sandboxSnapshots: {},
        suspendedTurn: null,
        recoveryRequired: false,
        agentBinding: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
