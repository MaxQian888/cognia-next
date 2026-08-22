/** @jest-environment node */
/**
 * Tests for Matrix access-token rotation.
 *
 * The distinction that carries the most weight here is `needsReauth`. Getting
 * it wrong in one direction strands a working bot until someone notices; in the
 * other it tells a user their session died because their wifi dropped.
 */

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
  connectorsKeyringSet: jest.fn(),
}))

import {
  __resetMatrixRotationForTesting,
  ACCESS_TOKEN_ACCOUNT,
  REFRESH_TOKEN_ACCOUNT,
  rotateMatrixAccessToken,
} from "./token-rotation"
import type { MatrixRefreshResult } from "./auth"

const getSecret = jest.fn()
const setSecret = jest.fn(async () => undefined)
const refresh = jest.fn()

function deps() {
  return { getSecret, setSecret, refresh } as never
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetMatrixRotationForTesting()
  getSecret.mockResolvedValue("refresh-1")
  setSecret.mockResolvedValue(undefined)
  refresh.mockResolvedValue({ ok: true, accessToken: "access-2" } as MatrixRefreshResult)
})

describe("rotateMatrixAccessToken", () => {
  it("exchanges the refresh token and persists the new access token", async () => {
    const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(result).toEqual({ ok: true, accessToken: "access-2" })
    expect(refresh).toHaveBeenCalledWith("https://matrix.org", "refresh-1")
    expect(setSecret).toHaveBeenCalledWith("mx-1", ACCESS_TOKEN_ACCOUNT, "access-2")
  })

  it("persists a rotated refresh token BEFORE the access token", async () => {
    // Matrix rotates refresh tokens, and the old one dies the moment a new one
    // is issued. If the process stops between the two writes, a stale access
    // token is recoverable — the next refresh fixes it — while a stale refresh
    // token is not, so the refresh token has to land first.
    refresh.mockResolvedValue({
      ok: true,
      accessToken: "access-2",
      refreshToken: "refresh-2",
    } as MatrixRefreshResult)

    await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())

    expect((setSecret.mock.calls as unknown as string[][]).map((c) => c[1])).toEqual([
      REFRESH_TOKEN_ACCOUNT,
      ACCESS_TOKEN_ACCOUNT,
    ])
    expect(setSecret).toHaveBeenCalledWith("mx-1", REFRESH_TOKEN_ACCOUNT, "refresh-2")
  })

  it("does not touch the refresh token when the server reuses it", async () => {
    await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(setSecret).toHaveBeenCalledTimes(1)
    expect(setSecret).toHaveBeenCalledWith("mx-1", ACCESS_TOKEN_ACCOUNT, "access-2")
  })

  it("asks for re-auth when no refresh token is stored", async () => {
    // The "paste an access token" setup path: there is nothing to exchange.
    getSecret.mockResolvedValue(null)
    const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(result).toMatchObject({ ok: false, needsReauth: true })
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each([[""], ["   "], [42], [{ status: 401 }]])(
    "treats a non-string keyring answer (%p) as no refresh token",
    async (stored) => {
      getSecret.mockResolvedValue(stored)
      const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
      expect(result).toMatchObject({ ok: false, needsReauth: true })
    }
  )

  it("asks for re-auth when the homeserver rejects the refresh token", async () => {
    refresh.mockResolvedValue({
      ok: false,
      reason: "rejected",
      error: "M_UNKNOWN_TOKEN",
    } as MatrixRefreshResult)
    const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(result).toMatchObject({ ok: false, needsReauth: true })
  })

  it("does NOT ask for re-auth on a network failure", async () => {
    // Telling someone their session expired because their connection blipped
    // costs them a re-login and their device's encryption keys.
    refresh.mockResolvedValue({
      ok: false,
      reason: "network",
      error: "connection reset",
    } as MatrixRefreshResult)
    const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(result).toMatchObject({ ok: false, needsReauth: false })
  })

  it("does NOT ask for re-auth when the keyring is unavailable", async () => {
    getSecret.mockRejectedValue(new Error("keyring locked"))
    const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(result).toMatchObject({ ok: false, needsReauth: false })
  })

  it("does NOT ask for re-auth when persisting the new token fails", async () => {
    setSecret.mockRejectedValue(new Error("keyring locked"))
    const result = await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(result).toMatchObject({ ok: false, needsReauth: false })
  })

  it("never throws, even when the refresh call itself does", async () => {
    // It runs inside the sync loop's retry path; a throw would look like a
    // transport error and the loop would spin rather than recover or report.
    refresh.mockRejectedValue(new Error("boom"))
    await expect(
      rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    ).resolves.toMatchObject({ ok: false, needsReauth: false })
  })

  it("shares one exchange between concurrent callers", async () => {
    // The sync loop and an outbound send can hit M_UNKNOWN_TOKEN in the same
    // instant. Two refreshes would burn one of the two rotated tokens.
    let release: (v: MatrixRefreshResult) => void = () => {}
    refresh.mockReturnValue(
      new Promise<MatrixRefreshResult>((resolve) => {
        release = resolve
      })
    )

    const a = rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    const b = rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    release({ ok: true, accessToken: "access-2" })

    expect(await a).toEqual({ ok: true, accessToken: "access-2" })
    expect(await b).toEqual({ ok: true, accessToken: "access-2" })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("allows a fresh exchange once the previous one settles", async () => {
    await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    await rotateMatrixAccessToken("mx-1", "https://matrix.org", deps())
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("keeps different adapters independent", async () => {
    await Promise.all([
      rotateMatrixAccessToken("mx-1", "https://matrix.org", deps()),
      rotateMatrixAccessToken("mx-2", "https://matrix.org", deps()),
    ])
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
