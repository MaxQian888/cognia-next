import { GITHUB_DOT_COM, parseGithubHost, type GithubHost } from "@/lib/github/host"
import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import {
  githubReadAccountsFor,
  resolveGithubReadToken,
  type GithubReadCredentialDeps,
} from "./github-read-credential"

const GHES = parseGithubHost("https://ghe.acme.io") as GithubHost

function account(over: Partial<IntegrationAccount>): IntegrationAccount {
  return {
    id: "acc",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "s-acc",
    remoteAccountId: "octocat",
    label: "octocat",
    enabled: true,
    health: "healthy",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

function deps(
  accounts: IntegrationAccount[],
  hosts: Record<string, GithubHost | undefined>,
  tokens: Record<string, string | null | Error> = {}
): GithubReadCredentialDeps & { resolveToken: jest.Mock } {
  return {
    listAccounts: async () => accounts,
    hostForSession: async (sessionId) => hosts[sessionId],
    resolveToken: jest.fn(async (candidate: IntegrationAccount) => {
      const value = tokens[candidate.id]
      if (value instanceof Error) throw value
      return value ?? null
    }),
  }
}

describe("githubReadAccountsFor", () => {
  it("keeps only enabled, non-revoked GitHub accounts on the repository's host", async () => {
    const accounts = [
      account({ id: "pat", authSessionId: "s1" }),
      account({ id: "off", authSessionId: "s2", enabled: false }),
      account({ id: "revoked", authSessionId: "s3", health: "revoked" }),
      account({ id: "ghes", authSessionId: "s4" }),
      account({ id: "lark", authSessionId: "s5", providerId: "lark-oauth" }),
      account({ id: "unknown-host", authSessionId: "s6" }),
    ]
    const d = deps(accounts, {
      s1: GITHUB_DOT_COM,
      s2: GITHUB_DOT_COM,
      s3: GITHUB_DOT_COM,
      s4: GHES,
      s5: GITHUB_DOT_COM,
    })
    expect((await githubReadAccountsFor("acme/app", GITHUB_DOT_COM, d)).map((a) => a.id)).toEqual([
      "pat",
    ])
    expect((await githubReadAccountsFor("acme/app", GHES, d)).map((a) => a.id)).toEqual(["ghes"])
  })

  it("ranks the owner's App install, then PATs, then other App installs", async () => {
    const accounts = [
      account({ id: "other-app", authSessionId: "s1", providerId: "github-app", label: "globex" }),
      account({ id: "pat", authSessionId: "s2" }),
      account({ id: "owner-app", authSessionId: "s3", providerId: "github-app", label: "ACME" }),
    ]
    const d = deps(accounts, { s1: GITHUB_DOT_COM, s2: GITHUB_DOT_COM, s3: GITHUB_DOT_COM })
    expect((await githubReadAccountsFor("acme/app", GITHUB_DOT_COM, d)).map((a) => a.id)).toEqual([
      "owner-app",
      "pat",
      "other-app",
    ])
  })

  it("answers an empty list when the account store cannot be read", async () => {
    const d: GithubReadCredentialDeps = {
      listAccounts: async () => {
        throw new Error("db closed")
      },
      hostForSession: async () => GITHUB_DOT_COM,
      resolveToken: async () => "t",
    }
    expect(await githubReadAccountsFor("acme/app", GITHUB_DOT_COM, d)).toEqual([])
  })
})

describe("resolveGithubReadToken", () => {
  it("returns the first candidate's token", async () => {
    const d = deps(
      [account({ id: "pat", authSessionId: "s1" })],
      { s1: GITHUB_DOT_COM },
      {
        pat: "ghp_pat",
      }
    )
    expect(await resolveGithubReadToken("acme/app", GITHUB_DOT_COM, d)).toBe("ghp_pat")
    expect(d.resolveToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pat" }),
      GITHUB_DOT_COM
    )
  })

  it("moves past a candidate whose credential cannot be resolved", async () => {
    const d = deps(
      [
        account({ id: "broken", authSessionId: "s1", providerId: "github-app", label: "acme" }),
        account({ id: "pat", authSessionId: "s2" }),
      ],
      { s1: GITHUB_DOT_COM, s2: GITHUB_DOT_COM },
      { broken: new Error("token exchange 401"), pat: "ghp_pat" }
    )
    expect(await resolveGithubReadToken("acme/app", GITHUB_DOT_COM, d)).toBe("ghp_pat")
  })

  it("never offers a github.com account's token to an enterprise host", async () => {
    const d = deps(
      [account({ id: "pat", authSessionId: "s1" })],
      { s1: GITHUB_DOT_COM },
      {
        pat: "ghp_pat",
      }
    )
    expect(await resolveGithubReadToken("acme/app", GHES, d)).toBeNull()
    expect(d.resolveToken).not.toHaveBeenCalled()
  })

  it("is null with no connected account", async () => {
    expect(await resolveGithubReadToken("acme/app", GITHUB_DOT_COM, deps([], {}))).toBeNull()
  })
})
