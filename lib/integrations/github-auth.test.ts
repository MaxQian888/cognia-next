/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getSession, __resetAuthRegistryForTesting } from "@/lib/plugin/auth/auth-provider-registry"
import {
  authenticatedGithubAppRequest,
  discoverGithubAppInstallations,
  registerGithubIntegrationAuthProviders,
  type GithubIntegrationSecretStore,
} from "./github-auth"

function memoryStore(): GithubIntegrationSecretStore {
  const values = new Map<string, string>()
  return {
    save: async (key, value) => void values.set(key, value),
    load: async (key) => values.get(key) ?? null,
    delete: async (key) => void values.delete(key),
  }
}

describe("host-owned GitHub Integration authentication", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetAuthRegistryForTesting()
  })

  it("keeps App credentials host-owned and caches installation tokens", async () => {
    const store = memoryStore()
    const fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "installation-token",
            expires_at: "2026-08-09T02:00:00.000Z",
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
              "x-github-request-id": "request-1",
            },
          }
        )
    )
    const dispose = registerGithubIntegrationAuthProviders({
      store,
      fetch,
      now: () => new Date("2026-08-09T01:00:00.000Z").getTime(),
      createAppJwt: async () => "signed-app-jwt",
      listAccountSessionIds: async () => [],
    })

    try {
      const session = await getSession("github-app", [], {
        createIfNone: true,
        configuration: {
          appId: 123,
          installationId: 456,
          privateKey: "private-key",
          accountLabel: "Cognia test app",
        },
      })
      expect(session).toMatchObject({
        accessToken: "host-resolved",
        account: { id: "456", label: "Cognia test app" },
      })

      const provider = (await import("@/lib/plugin/auth/auth-provider-registry")).getProvider(
        "github-app"
      )!
      await expect(
        provider.resolveRequestCredential!(session!.id, {
          accountId: "account-1",
          origin: "https://api.github.com",
        })
      ).resolves.toMatchObject({ accessToken: "installation-token" })
      await provider.resolveRequestCredential!(session!.id, {
        accountId: "account-1",
        origin: "https://api.github.com",
      })

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/app/installations/456/access_tokens",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer signed-app-jwt" }),
        })
      )
      expect(JSON.stringify(session)).not.toContain("private-key")
      expect(JSON.stringify(session)).not.toContain("installation-token")
    } finally {
      dispose()
    }
  })

  it("retains PAT as an advanced host-resolved fallback", async () => {
    const dispose = registerGithubIntegrationAuthProviders({
      store: memoryStore(),
      listAccountSessionIds: async () => [],
    })
    try {
      const session = await getSession("github-pat", ["repo"], {
        createIfNone: true,
        configuration: { token: "github-pat-secret", accountLabel: "octocat" },
      })
      const provider = (await import("@/lib/plugin/auth/auth-provider-registry")).getProvider(
        "github-pat"
      )!
      await expect(
        provider.resolveRequestCredential!(session!.id, {
          accountId: "account-1",
          origin: "https://api.github.com",
        })
      ).resolves.toEqual({ accessToken: "github-pat-secret" })
      expect(session?.accessToken).toBe("host-resolved")
    } finally {
      dispose()
    }
  })

  it("uses an App JWT for host-only webhook delivery APIs", async () => {
    const fetch = jest.fn(
      async () =>
        new Response(JSON.stringify([{ id: 100 }]), {
          status: 200,
          headers: { "content-type": "application/json", "x-github-request-id": "request-2" },
        })
    )
    const dispose = registerGithubIntegrationAuthProviders({
      store: memoryStore(),
      fetch,
      now: () => new Date("2026-08-09T01:00:00.000Z").getTime(),
      createAppJwt: async () => "app-jwt",
      listAccountSessionIds: async () => [],
    })
    try {
      const session = await getSession("github-app", [], {
        createIfNone: true,
        configuration: { appId: 1, installationId: 2, privateKey: "private-key" },
      })
      await expect(
        authenticatedGithubAppRequest<Array<{ id: number }>>(session!.id, "/app/hook/deliveries")
      ).resolves.toMatchObject({ status: 200, data: [{ id: 100 }] })
      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/app/hook/deliveries",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer app-jwt" }),
        })
      )
    } finally {
      dispose()
    }
  })

  it("discovers installations during guided App setup without creating a session", async () => {
    const fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: 42, account: { login: "cognia", avatar_url: "https://example/avatar.png" } },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    )

    await expect(
      discoverGithubAppInstallations(
        { appId: 1, privateKey: "private-key" },
        {
          fetch,
          now: () => Date.parse("2026-08-09T01:00:00Z"),
          createAppJwt: async () => "app-jwt",
        }
      )
    ).resolves.toEqual([{ id: "42", label: "cognia", avatarUrl: "https://example/avatar.png" }])
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer app-jwt" }),
      })
    )
  })
})
