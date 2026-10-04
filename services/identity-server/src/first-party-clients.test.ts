import { afterEach, describe, expect, it } from "vitest"

import { testEnv } from "../test/helpers"
import {
  COGNIA_WEB_CLIENT_ID,
  reconcileWebClient,
  resetWebClientReconciliation,
  webClientUris,
} from "./first-party-clients"

async function webClientRow() {
  return testEnv.DB.prepare(
    'SELECT "redirectUris", "postLogoutRedirectUris" FROM "oauthClient" WHERE "clientId" = ?'
  )
    .bind(COGNIA_WEB_CLIENT_ID)
    .first<{ redirectUris: string; postLogoutRedirectUris: string }>()
}

describe("first-party clients", () => {
  afterEach(() => resetWebClientReconciliation())

  it("are seeded public, PKCE-only and owned by nobody", async () => {
    const { results } = await testEnv.DB.prepare(
      'SELECT "clientId", "clientSecret", "tokenEndpointAuthMethod", "requirePKCE", "skipConsent", "userId", "redirectUris" FROM "oauthClient" ORDER BY "clientId"'
    ).all<Record<string, unknown>>()
    expect(results.map((row) => row.clientId)).toEqual(["cognia-app", "cognia-web"])
    for (const row of results) {
      expect(row).toMatchObject({
        clientSecret: null,
        tokenEndpointAuthMethod: "none",
        requirePKCE: 1,
        skipConsent: 1,
        userId: null,
      })
    }
    expect(JSON.parse(String(results[0]!.redirectUris))).toEqual([
      "cn.cognia.app:/auth/callback",
      "http://127.0.0.1/callback",
    ])
    const links = await testEnv.DB.prepare(
      'SELECT "clientId", "resourceId" FROM "oauthClientResource" ORDER BY "clientId"'
    ).all()
    expect(links.results).toEqual([
      { clientId: "cognia-app", resourceId: "https://sync.cognia.cn" },
      { clientId: "cognia-web", resourceId: "https://sync.cognia.cn" },
    ])
  })

  it("derive the web client's URIs from the configured origins", () => {
    expect(webClientUris(["https://app.cognia.cn", "http://localhost:3000"])).toEqual({
      redirectUris: [
        "https://app.cognia.cn/logto/callback",
        "http://localhost:3000/logto/callback",
      ],
      postLogoutRedirectUris: ["https://app.cognia.cn/", "http://localhost:3000/"],
    })
  })

  it("reconcile the web client's URIs once, then skip", async () => {
    const origins = ["https://app.example", "http://localhost:3000"]
    expect(await reconcileWebClient(testEnv.DB, origins, new Date("2026-10-05T00:00:00Z"))).toBe(
      "updated"
    )
    const row = await webClientRow()
    expect(JSON.parse(row!.redirectUris)).toEqual(webClientUris(origins).redirectUris)
    expect(await reconcileWebClient(testEnv.DB, origins)).toBe("unchanged")
    resetWebClientReconciliation()
    // A fresh isolate sees the stored value already matches.
    expect(await reconcileWebClient(testEnv.DB, origins)).toBe("unchanged")
  })
})
