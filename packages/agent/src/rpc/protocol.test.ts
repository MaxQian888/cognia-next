/**
 * Tests for the JSON-RPC 2.0 protocol layer.
 */

import {
  HOST_REQUEST_METHODS,
  parseHostRequestParams,
  parseRpcMethodParams,
  parseRpcMethodResult,
  isJsonRpcRequest,
  isJsonRpcNotification,
  makeErrorResponse,
  makeNotification,
  makeSuccessResponse,
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_PROTOCOL_VERSION,
} from "./protocol"

describe("RPC protocol", () => {
  describe("isJsonRpcRequest", () => {
    it("accepts a valid request", () => {
      expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "session.create" })).toBe(true)
    })

    it("accepts string id", () => {
      expect(isJsonRpcRequest({ jsonrpc: "2.0", id: "abc", method: "turn.run" })).toBe(true)
    })

    it("rejects missing jsonrpc", () => {
      expect(isJsonRpcRequest({ id: 1, method: "test" })).toBe(false)
    })

    it("rejects missing id", () => {
      expect(isJsonRpcRequest({ jsonrpc: "2.0", method: "test" })).toBe(false)
    })

    it("rejects missing method", () => {
      expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1 })).toBe(false)
    })

    it("rejects null", () => {
      expect(isJsonRpcRequest(null)).toBe(false)
    })

    it("rejects non-object", () => {
      expect(isJsonRpcRequest("string")).toBe(false)
    })
  })

  describe("isJsonRpcNotification", () => {
    it("accepts a valid notification", () => {
      expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "agent.event" })).toBe(true)
    })

    it("rejects when id is present", () => {
      expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "test" })).toBe(false)
    })
  })

  describe("makeSuccessResponse", () => {
    it("builds a valid success response", () => {
      const resp = makeSuccessResponse(42, { ok: true })
      expect(resp).toEqual({ jsonrpc: "2.0", id: 42, result: { ok: true } })
    })
  })

  describe("makeErrorResponse", () => {
    it("builds an error response with data", () => {
      const resp = makeErrorResponse(1, -32600, "bad request", { detail: "x" })
      expect(resp.jsonrpc).toBe("2.0")
      expect(resp.id).toBe(1)
      expect(resp.error.code).toBe(-32600)
      expect(resp.error.message).toBe("bad request")
      expect(resp.error.data).toEqual({ detail: "x" })
    })

    it("omits data when undefined", () => {
      const resp = makeErrorResponse(2, -32700, "parse")
      expect(resp.error).not.toHaveProperty("data")
    })
  })

  describe("makeNotification", () => {
    it("builds a notification with params", () => {
      const n = makeNotification("agent.event", { sessionId: "s1" })
      expect(n).toEqual({ jsonrpc: "2.0", method: "agent.event", params: { sessionId: "s1" } })
    })

    it("omits params when undefined", () => {
      const n = makeNotification("runtime.shutdown")
      expect(n).not.toHaveProperty("params")
    })
  })

  describe("constants", () => {
    it("uses the stable bidirectional protocol version", () => {
      expect(RPC_PROTOCOL_VERSION).toBe(2)
    })

    it("has standard error codes", () => {
      expect(RPC_ERROR_CODES.parseError).toBe(-32700)
      expect(RPC_ERROR_CODES.invalidRequest).toBe(-32600)
      expect(RPC_ERROR_CODES.methodNotFound).toBe(-32601)
    })

    it("publishes the complete v2 client-to-host method catalog", () => {
      expect(RPC_METHODS).toEqual([
        "initialize",
        "initialized",
        "shutdown",
        "runtime/status",
        "runtime/capabilities",
        "model/list",
        "model/refresh",
        "auth/status",
        "session/create",
        "session/open",
        "session/list",
        "session/state",
        "session/messages",
        "session/entries",
        "session/rename",
        "session/tag",
        "session/delete",
        "session/export",
        "session/import",
        "session/fork",
        "session/clone",
        "session/tree",
        "session/close",
        "turn/run",
        "turn/steer",
        "turn/followUp",
        "turn/abort",
        "turn/wait",
        "session/model/set",
        "session/thinking/set",
        "session/permissionMode/set",
        "session/compact",
        "session/compact/undo",
        "permission/respond",
        "elicitation/respond",
        "externalTool/respond",
        "tool/register",
        "tool/unregister",
        "hook/register",
        "hook/unregister",
        "mcp/configure",
        "mcp/status",
        "plugin/reload",
        "skill/reload",
        "task/list",
        "task/stop",
        "task/background",
        "sandbox/status",
        "sandbox/snapshot",
        "sandbox/restore",
        "trace/subscribe",
        "trace/export",
        "audit/query",
      ])
      expect(HOST_REQUEST_METHODS).toEqual(["client/tool/invoke", "client/hook/invoke"])
    })

    it("validates required parameters through the schema map", () => {
      expect(parseRpcMethodParams("session/state", { sessionId: "session-1" })).toEqual({
        sessionId: "session-1",
      })
      expect(() => parseRpcMethodParams("session/state", {})).toThrow(/sessionId/i)
      expect(() => parseRpcMethodParams("turn/run", { sessionId: "session-1" })).toThrow(/input/i)
    })

    it("validates the additive worker dispatch contract", () => {
      const handoff = {
        envelopeVersion: 1 as const,
        identity: {
          parentRunId: "run-parent",
          childRunId: "run-child",
          depth: 1,
          parentChain: ["run-parent"],
        },
        task: { prompt: "Implement the child task" },
        execution: { mode: "orchestrated" as const },
        resources: [{ kind: "repository", ref: "repository:project-1:repo-1" }],
        createdAt: "2026-08-12T00:00:00.000Z",
      }

      expect(
        parseRpcMethodParams("session/create", { commandId: "lease-1", handoff })
      ).toMatchObject({ commandId: "lease-1", handoff })
      expect(() =>
        parseRpcMethodParams("session/create", {
          commandId: "lease-2",
          handoff: {
            ...handoff,
            resources: [{ kind: "repository", ref: "/tmp/repository" }],
          },
        })
      ).toThrow(/stable ref/i)

      expect(
        parseRpcMethodResult("initialize", {
          protocolVersion: 2,
          host: { name: "worker", version: "0.1.0" },
          runtimeVersion: "0.1.0",
          instanceId: "worker-1",
          methods: RPC_METHODS,
          capabilities: ["worker-dispatch-v1"],
          limits: {},
          workerManifest: {
            manifestVersion: 1,
            runtime: "builtin",
            models: ["test-model"],
            hardCapabilities: ["filesystem.write"],
            maxActiveTurns: 1,
            credentialProfileRefs: ["credential:test"],
            workspaceBindingRefs: ["repository:project-1:repo-1"],
            taskWorkspace: { enabled: true },
            sandbox: { capabilities: ["filesystem.write"] },
            platform: { os: "linux", arch: "x64" },
          },
        }).workerManifest
      ).toMatchObject({ manifestVersion: 1, maxActiveTurns: 1 })
    })

    it("validates host callback parameters independently", () => {
      expect(
        parseHostRequestParams("client/tool/invoke", {
          handlerId: "tool-handler",
          toolCallId: "tool-call-1",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          idempotencyKey: "idem-1",
          input: { path: "README.md" },
        })
      ).toMatchObject({ handlerId: "tool-handler", toolCallId: "tool-call-1" })
      expect(() =>
        parseHostRequestParams("client/tool/invoke", { handlerId: "tool-handler" })
      ).toThrow(/toolCallId/i)
    })
  })
})
