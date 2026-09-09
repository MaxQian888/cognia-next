/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getSession, __resetAuthRegistryForTesting } from "@/lib/plugin/auth/auth-provider-registry"
import {
  authenticatedGithubAppRequest,
  configuredGithubHosts,
  discoverGithubAppInstallations,
  githubHostForSession,
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

  it("sends an enterprise account's requests to its own server, never api.github.com", async () => {
    // ADR-0176. `https://api.github.com` was a literal in three places here, so
    // a GitHub Enterprise App silently authenticated against the public host:
    // the JWT is signed by an app that server has never heard of, and the
    // failure reads like a bad private key.
    const fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe-token", expires_at: "2026-08-09T02:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    )
    const dispose = registerGithubIntegrationAuthProviders({
      store: memoryStore(),
      fetch,
      now: () => new Date("2026-08-09T01:00:00.000Z").getTime(),
      createAppJwt: async () => "signed-app-jwt",
      listAccountSessionIds: async () => [],
    })
    try {
      const session = await getSession("github-app", [], {
        createIfNone: true,
        configuration: {
          appId: 1,
          installationId: 99,
          privateKey: "private-key",
          accountLabel: "Enterprise",
          hostUrl: "https://ghe.example.com",
        },
      })
      const provider = (await import("@/lib/plugin/auth/auth-provider-registry")).getProvider(
        "github-app"
      )!
      await provider.resolveRequestCredential!(session!.id, {
        accountId: "a",
        origin: "https://ghe.example.com",
      })

      expect(fetch).toHaveBeenCalledWith(
        "https://ghe.example.com/api/v3/app/installations/99/access_tokens",
        expect.objectContaining({ method: "POST" })
      )
      await expect(githubHostForSession(session!.id)).resolves.toMatchObject({
        id: "ghe.example.com",
        apiBaseUrl: "https://ghe.example.com/api/v3",
      })
      // The configured set is the allow-list a remote is matched against, and
      // github.com is always on it.
      await expect(configuredGithubHosts()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "github.com" }),
          expect.objectContaining({ id: "ghe.example.com" }),
        ])
      )
    } finally {
      dispose()
    }
  })

  it("refuses a host a credential must not be sent to instead of storing it", async () => {
    const dispose = registerGithubIntegrationAuthProviders({
      store: memoryStore(),
      listAccountSessionIds: async () => [],
    })
    try {
      await expect(
        getSession("github-pat", [], {
          createIfNone: true,
          configuration: {
            token: "ghp_test",
            accountLabel: "Plaintext",
            hostUrl: "http://ghe.example.com",
          },
        })
      ).rejects.toThrow(/not an https GitHub Enterprise URL/)
    } finally {
      dispose()
    }
  })

  it("answers github.com for an account stored before hosts existed", async () => {
    const dispose = registerGithubIntegrationAuthProviders({
      store: memoryStore(),
      listAccountSessionIds: async () => [],
    })
    try {
      const session = await getSession("github-pat", [], {
        createIfNone: true,
        configuration: { token: "ghp_test", accountLabel: "Legacy" },
      })
      await expect(githubHostForSession(session!.id)).resolves.toBe(
        (await import("@/lib/github/host")).GITHUB_DOT_COM
      )
      await expect(githubHostForSession("no-such-session")).resolves.toBeUndefined()
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
