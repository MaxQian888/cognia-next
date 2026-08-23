import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

  it("round-trips a valid agent binding and rejects a malformed one", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cognia-rpc-state-"))
    try {
      const store = createDurableRpcStateStore((sessionId) => path.join(root, sessionId))
      store.update("valid", (state) => {
        state.agentBinding = {
          agentId: "release-bot",
          version: 2,
          definitionDigest: "sha256-definition",
          compositionPresetId: "coding",
          compositionDigest: `sha256:${"a".repeat(64)}`,
          executionFingerprint: "fingerprint-1",
        }
      })
      expect(store.read("valid").agentBinding).toMatchObject({
        agentId: "release-bot",
        version: 2,
        compositionPresetId: "coding",
      })

      store.update("invalid", (state) => {
        state.agentBinding = null
      })
      const invalidFile = path.join(root, "invalid", "rpc-state.json")
      const parsed = JSON.parse(readFileSync(invalidFile, "utf8")) as Record<string, unknown>
      parsed.agentBinding = { agentId: "release-bot", version: "two" }
      writeFileSync(invalidFile, JSON.stringify(parsed))
      expect(store.read("invalid").agentBinding).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
