import {
  AccountDeletionError,
  accountDeletionUrl,
  cancelAccountDeletion,
  confirmAccountDeletion,
  readAccountDeletion,
  requestAccountDeletion,
} from "./official-account-deletion"
import { officialDeployment } from "./official-deployment"

import type { LogtoClientConfig, LogtoDrivers, LogtoSession } from "@/lib/logto/client"

const ISSUER = "https://id.cognia.cn/api/auth"
const URL_ = "https://id.cognia.cn/api/account/deletion"

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function respond(status: number, body: unknown) {
  return jest.fn(async () => new Response(JSON.stringify(body), { status }))
}

const current = { issuer: ISSUER, accessToken: token({ sub: "usr_ada" }) }
const drivers: LogtoDrivers = { openUrl: jest.fn(), waitForCode: jest.fn() }

describe("the deletion endpoint", () => {
  it("lives beside the issuer, on its origin", () => {
    expect(accountDeletionUrl(ISSUER)).toBe(URL_)
    expect(accountDeletionUrl("http://localhost:8787/api/auth")).toBe(
      "http://localhost:8787/api/account/deletion"
    )
  })

  it("reads the state with the bearer token", async () => {
    const fetchImpl = respond(200, {
      status: "pending",
      requestedAt: "2026-10-05T00:00:00.000Z",
      purgeAfter: "2026-10-12T00:00:00.000Z",
    })
    await expect(readAccountDeletion(current, { fetchImpl })).resolves.toEqual({
      status: "pending",
      requestedAt: "2026-10-05T00:00:00.000Z",
      purgeAfter: "2026-10-12T00:00:00.000Z",
    })
    expect(fetchImpl).toHaveBeenCalledWith(URL_, {
      method: "GET",
      headers: { authorization: `Bearer ${current.accessToken}`, accept: "application/json" },
    })
  })

  it("cancels with DELETE and reads an unknown status as none", async () => {
    const fetchImpl = respond(200, { status: "weird" })
    await expect(cancelAccountDeletion(current, { fetchImpl })).resolves.toEqual({
      status: "none",
    })
    expect(fetchImpl).toHaveBeenCalledWith(URL_, expect.objectContaining({ method: "DELETE" }))
  })

  it("names a refused token, a stale sign-in, and anything else", async () => {
    await expect(
      readAccountDeletion(current, {
        fetchImpl: respond(401, { error: "invalid_token", error_description: "expired" }),
      })
    ).rejects.toMatchObject({ code: "unauthorized", message: "expired" })
    await expect(
      readAccountDeletion(current, { fetchImpl: respond(403, { error: "x" }) })
    ).rejects.toMatchObject({ code: "stale-sign-in", message: "HTTP 403" })
    await expect(
      readAccountDeletion(current, {
        fetchImpl: jest.fn(async () => new Response("oops", { status: 503 })),
      })
    ).rejects.toMatchObject({ code: "failed" })
  })

  it("requests with the fresh ID token in the body, and refuses without one", async () => {
    const fetchImpl = respond(200, { status: "pending", purgeAfter: "p" })
    await requestAccountDeletion({ ...current, idToken: "id.token.sig" }, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(URL_, {
      method: "POST",
      headers: {
        authorization: `Bearer ${current.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id_token: "id.token.sig" }),
    })
    await expect(requestAccountDeletion(current)).rejects.toBeInstanceOf(AccountDeletionError)
  })
})

describe("confirmAccountDeletion", () => {
  const deployment = officialDeployment({})!

  function freshLogin(sub: string) {
    let seen: LogtoClientConfig | undefined
    const login = jest.fn(async (config: LogtoClientConfig) => {
      seen = config
      return {
        issuer: ISSUER,
        clientId: "cognia-app",
        resource: "https://sync.cognia.cn",
        accessToken: token({ sub }),
        idToken: "fresh.id.token",
        scopes: [],
      } satisfies LogtoSession
    })
    return { login, config: () => seen }
  }

  it("signs in afresh as the same person and requests with that sign-in", async () => {
    const { login, config } = freshLogin("usr_ada")
    const fetchImpl = respond(200, { status: "pending", purgeAfter: "p" })
    const state = await confirmAccountDeletion(
      deployment,
      drivers,
      { redirectUri: "cn.cognia.app:/auth/callback", clientKind: "native" },
      current,
      { login, fetchImpl }
    )
    expect(state).toEqual({ status: "pending", purgeAfter: "p" })
    expect(config()).toMatchObject({ freshLogin: true, clientId: "cognia-app" })
    expect(login).toHaveBeenCalledWith(expect.anything(), drivers)
    expect(fetchImpl).toHaveBeenCalledWith(
      URL_,
      expect.objectContaining({ body: JSON.stringify({ id_token: "fresh.id.token" }) })
    )
  })

  it("refuses when the fresh sign-in is somebody else, before asking the Worker", async () => {
    const { login } = freshLogin("usr_mallory")
    const fetchImpl = jest.fn()
    await expect(
      confirmAccountDeletion(
        deployment,
        drivers,
        { redirectUri: "x", clientKind: "web" },
        current,
        { login, fetchImpl }
      )
    ).rejects.toMatchObject({ code: "different-person" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses a profile whose session names nobody", async () => {
    const { login } = freshLogin("usr_ada")
    await expect(
      confirmAccountDeletion(
        deployment,
        drivers,
        { redirectUri: "x", clientKind: "web" },
        { accessToken: "opaque" },
        { login }
      )
    ).rejects.toMatchObject({ code: "unauthorized" })
    expect(login).not.toHaveBeenCalled()
  })
})
