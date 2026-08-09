/**
 * Tests for the JSON-RPC 2.0 protocol layer.
 */

import {
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
    it("protocol version is 1", () => {
      expect(RPC_PROTOCOL_VERSION).toBe(1)
    })

    it("has standard error codes", () => {
      expect(RPC_ERROR_CODES.parseError).toBe(-32700)
      expect(RPC_ERROR_CODES.invalidRequest).toBe(-32600)
      expect(RPC_ERROR_CODES.methodNotFound).toBe(-32601)
    })

    it("method catalog includes core methods", () => {
      expect(RPC_METHODS).toContain("runtime.discover")
      expect(RPC_METHODS).toContain("session.create")
      expect(RPC_METHODS).toContain("turn.run")
      expect(RPC_METHODS).toContain("session.annotation")
    })
  })
})
