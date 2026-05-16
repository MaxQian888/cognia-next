import { transport } from "@/lib/tauri"

import {
  deadlineMsFromResponse,
  intervalMsFromResponse,
  pendingIsTerminal,
  pollCodexDeviceCode,
  pollOutcomeKind,
  pollOutcomePayload,
  refreshCodexToken,
  requestCodexDeviceCode,
  revokeCodexToken,
  tokenResponseToCredential,
} from "./oauth"
import type { CodexCredential, DeviceCodeResponse, PollOutcome, TokenResponse } from "./types"

const deviceCode: DeviceCodeResponse = {
  device_code: "dc-test",
  user_code: "CODE-1234",
  verification_uri: "https://chat.openai.com/d",
  verification_uri_complete: "https://chat.openai.com/d?u=CODE-1234",
  expires_in: 900,
  interval: 5,
}

const tokenResponse: TokenResponse = {
  access_token: "oat-fresh",
  refresh_token: "rt-fresh",
  id_token: "eyJ.fresh.jwt",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid profile email offline_access",
}

beforeEach(() => {
  jest.spyOn(transport, "call")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("oauth IPC wrappers", () => {
  it("requestCodexDeviceCode calls codex_sub_request_device_code", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(deviceCode)
    const got = await requestCodexDeviceCode()
    expect(transport.call).toHaveBeenCalledWith("codex_sub_request_device_code")
    expect(got).toEqual(deviceCode)
  })

  it("pollCodexDeviceCode forwards device_code", async () => {
    const outcome: PollOutcome = { Granted: tokenResponse }
    ;(transport.call as jest.Mock).mockResolvedValueOnce(outcome)
    const got = await pollCodexDeviceCode("dc-test")
    expect(transport.call).toHaveBeenCalledWith("codex_sub_poll_device_code", {
      deviceCode: "dc-test",
    })
    expect(got).toEqual(outcome)
  })

  it("refreshCodexToken forwards refresh_token", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(tokenResponse)
    await refreshCodexToken("rt-test")
    expect(transport.call).toHaveBeenCalledWith("codex_sub_refresh", {
      refreshToken: "rt-test",
    })
  })

  it("revokeCodexToken forwards token", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(undefined)
    await revokeCodexToken("rt-test")
    expect(transport.call).toHaveBeenCalledWith("codex_sub_revoke", { token: "rt-test" })
  })

  it("plain-web mode rejects through the WebStub transport", async () => {
    jest.restoreAllMocks()
    await expect(requestCodexDeviceCode()).rejects.toThrow(
      /tauri-only command from web mode: codex_sub_request_device_code/
    )
  })
})

describe("tokenResponseToCredential", () => {
  const now = 1_700_000_000_000

  it("computes absolute expiry from expires_in", () => {
    const got = tokenResponseToCredential(tokenResponse, { authMode: "chatgpt", nowMs: now })
    expect(got.expiresAtMs).toBe(now + 3600 * 1000)
    expect(got.accessToken).toBe("oat-fresh")
    expect(got.refreshToken).toBe("rt-fresh")
    expect(got.idTokenRaw).toBe("eyJ.fresh.jwt")
    expect(got.authMode).toBe("chatgpt")
    expect(got.originalSource).toBe("oauth")
    expect(got.storedAtMs).toBe(now)
  })

  it("falls back to previous refresh_token when server omits one", () => {
    const previous: CodexCredential = {
      accessToken: "old",
      refreshToken: "rt-previous",
      idTokenRaw: "old.jwt",
      expiresAtMs: now - 1000,
      authMode: "chatgpt",
      originalSource: "file",
      storedAtMs: now - 60_000,
      email: "old@example.com",
    }
    const partial: TokenResponse = { access_token: "oat-new", expires_in: 1800 }
    const got = tokenResponseToCredential(partial, { previous, nowMs: now })
    expect(got.refreshToken).toBe("rt-previous")
    expect(got.idTokenRaw).toBe("old.jwt")
    expect(got.email).toBe("old@example.com")
    expect(got.originalSource).toBe("file") // preserved from previous
  })

  it("uses 0 expiry when expires_in is missing", () => {
    const got = tokenResponseToCredential({ access_token: "x" }, { nowMs: now })
    expect(got.expiresAtMs).toBe(0)
  })

  it("respects the explicit authMode override", () => {
    const got = tokenResponseToCredential(
      { access_token: "sk-x" },
      { authMode: "api_key", nowMs: now }
    )
    expect(got.authMode).toBe("api_key")
  })
})

describe("device-code helpers", () => {
  it("intervalMsFromResponse converts seconds to ms", () => {
    expect(intervalMsFromResponse(deviceCode)).toBe(5000)
  })

  it("intervalMsFromResponse defaults when interval is missing", () => {
    expect(intervalMsFromResponse({ ...deviceCode, interval: 0 })).toBe(5000)
  })

  it("deadlineMsFromResponse adds expires_in seconds", () => {
    const got = deadlineMsFromResponse(deviceCode, 1000)
    expect(got).toBe(1000 + 900 * 1000)
  })

  it("deadlineMsFromResponse falls back to a 15-minute cap", () => {
    const got = deadlineMsFromResponse({ ...deviceCode, expires_in: 0 }, 1000)
    expect(got).toBe(1000 + 15 * 60 * 1000)
  })
})

describe("poll outcome helpers", () => {
  const granted: PollOutcome = { Granted: tokenResponse }
  const pending: PollOutcome = {
    Pending: { error: "authorization_pending" },
  }

  it("pollOutcomeKind discriminates", () => {
    expect(pollOutcomeKind(granted)).toBe("granted")
    expect(pollOutcomeKind(pending)).toBe("pending")
  })

  it("pollOutcomePayload returns the inner shape", () => {
    expect(pollOutcomePayload(granted)).toEqual(tokenResponse)
    expect(pollOutcomePayload(pending)).toEqual({ error: "authorization_pending" })
  })

  it("pendingIsTerminal flags expired_token and access_denied", () => {
    expect(pendingIsTerminal({ error: "expired_token" })).toBe(true)
    expect(pendingIsTerminal({ error: "access_denied" })).toBe(true)
  })

  it("pendingIsTerminal returns false for retryable codes", () => {
    expect(pendingIsTerminal({ error: "authorization_pending" })).toBe(false)
    expect(pendingIsTerminal({ error: "slow_down" })).toBe(false)
  })
})
