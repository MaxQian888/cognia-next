/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

const statusMock = jest.fn()
jest.mock("@/lib/mcp/oauth-tauri", () => ({
  mcpOAuthStatus: (...a: unknown[]) => statusMock(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

import { isTauri } from "@/lib/tauri"
import { useMcpOAuthStatus } from "./use-mcp-oauth-status"

const isTauriMock = isTauri as jest.Mock

beforeEach(() => {
  statusMock.mockReset()
  isTauriMock.mockReturnValue(true)
})

describe("useMcpOAuthStatus", () => {
  it("is 'unsupported' for stdio servers without probing", async () => {
    const { result } = renderHook(() => useMcpOAuthStatus("srv", "stdio"))
    expect(result.current.status).toBe("unsupported")
    expect(statusMock).not.toHaveBeenCalled()
  })

  it("is 'none' in web mode", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useMcpOAuthStatus("srv", "http"))
    await waitFor(() => expect(result.current.status).toBe("none"))
    expect(statusMock).not.toHaveBeenCalled()
  })

  it("resolves to 'authorized' when tokens are present and unexpired", async () => {
    statusMock.mockResolvedValue({ hasTokens: true, expiresAtMs: Date.now() + 100_000 })
    const { result } = renderHook(() => useMcpOAuthStatus("srv", "http"))
    await waitFor(() => expect(result.current.status).toBe("authorized"))
  })

  it("resolves to 'expired' when the token expiry is in the past", async () => {
    statusMock.mockResolvedValue({ hasTokens: true, expiresAtMs: Date.now() - 1 })
    const { result } = renderHook(() => useMcpOAuthStatus("srv", "sse"))
    await waitFor(() => expect(result.current.status).toBe("expired"))
  })

  it("resolves to 'none' when there are no tokens", async () => {
    statusMock.mockResolvedValue({ hasTokens: false })
    const { result } = renderHook(() => useMcpOAuthStatus("srv", "http"))
    await waitFor(() => expect(result.current.status).toBe("none"))
  })

  it("falls back to 'none' when the status call throws", async () => {
    statusMock.mockRejectedValue(new Error("keyring down"))
    const { result } = renderHook(() => useMcpOAuthStatus("srv", "http"))
    await waitFor(() => expect(result.current.status).toBe("none"))
  })
})
