import type { GitRemote } from "@/types/git"
import type { OctokitLike } from "@/lib/github/pr-observe/types"
import { GITHUB_DOT_COM, parseGithubHost, type GithubHost } from "@/lib/github/host"

import { openStackForge, pickForgeRemote } from "./forge-session"
import { createFakeForge } from "./forge/fake"

const octokit = {} as OctokitLike

function remote(name: string, url: string): GitRemote {
  return { name, fetchUrl: url, pushUrl: url }
}

function deps(overrides: {
  remotes?: GitRemote[]
  octokit?: OctokitLike | null | (() => Promise<never>)
  hosts?: GithubHost[] | (() => Promise<never>)
}) {
  return {
    remotes: async () => overrides.remotes ?? [],
    octokit: async () => {
      const value = overrides.octokit
      if (typeof value === "function") return value()
      return value === undefined ? octokit : value
    },
    adapter: () => createFakeForge(),
    // Default to the public host alone, which is what an account list with no
    // enterprise entry answers.
    hosts: async () => {
      const value = overrides.hosts
      if (typeof value === "function") return value()
      return value ?? [GITHUB_DOT_COM]
    },
  }
}

describe("pickForgeRemote", () => {
  it("prefers origin", () => {
    const picked = pickForgeRemote([
      remote("upstream", "https://github.com/upstream/app.git"),
      remote("origin", "https://github.com/me/app.git"),
    ])
    expect(picked?.name).toBe("origin")
  })

  it("falls back to the first remote that has a URL", () => {
    // A fork checkout often has only `upstream`. Refusing to look at it
    // because of its name is a worse answer than the fork refusal publishing
    // already gives, which at least says why.
    const picked = pickForgeRemote([
      remote("empty", "  "),
      remote("upstream", "git@github.com:u/a"),
    ])
    expect(picked?.name).toBe("upstream")
  })

  it("returns null when nothing has a URL", () => {
    expect(pickForgeRemote([remote("origin", "")])).toBeNull()
  })
})

describe("openStackForge", () => {
  it("is ready when a GitHub remote and a credential both resolve", async () => {
    const forge = await openStackForge(
      "/repo",
      deps({ remotes: [remote("origin", "git@github.com:acme/app.git")] })
    )
    expect(forge).toMatchObject({ status: "ready", repository: "acme/app", remote: "origin" })
  })

  it("reports no remote when there is none", async () => {
    expect(await openStackForge("/repo", deps({}))).toEqual({ status: "noRemote" })
  })

  it("reports no remote for a local path remote", async () => {
    // A `file://` or sibling-directory remote is a real remote and still has
    // nowhere to open a pull request.
    const forge = await openStackForge(
      "/repo",
      deps({ remotes: [remote("origin", "/srv/mirrors/app.git")] })
    )
    expect(forge).toEqual({ status: "noRemote" })
  })

  it("names the host it has no adapter for", async () => {
    const forge = await openStackForge(
      "/repo",
      deps({ remotes: [remote("origin", "https://gitlab.com/acme/app.git")] })
    )
    expect(forge).toEqual({ status: "unsupportedHost", host: "gitlab.com", remote: "origin" })
  })

  it("serves a configured GitHub Enterprise remote instead of calling it unsupported", async () => {
    // ADR-0176. The panel used to say "no adapter for github.acme.com" to a
    // user who had an account on exactly that server.
    const ghe = parseGithubHost("https://github.acme.com")!
    const forge = await openStackForge(
      "/repo",
      deps({
        remotes: [remote("origin", "https://github.acme.com/acme/app.git")],
        hosts: [GITHUB_DOT_COM, ghe],
      })
    )
    expect(forge).toMatchObject({ status: "ready", repository: "acme/app", remote: "origin" })
  })

  it("still refuses an enterprise host nobody configured", async () => {
    const forge = await openStackForge(
      "/repo",
      deps({ remotes: [remote("origin", "https://github.acme.com/acme/app.git")] })
    )
    expect(forge).toEqual({
      status: "unsupportedHost",
      host: "github.acme.com",
      remote: "origin",
    })
  })

  it("falls back to the public host when the account list cannot be read", async () => {
    // Failing to enumerate accounts must not break a github.com repository:
    // the empty list still recognises the public host.
    const forge = await openStackForge(
      "/repo",
      deps({
        remotes: [remote("origin", "https://github.com/acme/app.git")],
        hosts: () => Promise.reject(new Error("keyring locked")) as Promise<never>,
      })
    )
    expect(forge).toMatchObject({ status: "ready", repository: "acme/app" })
  })

  it("keeps 'no credential' apart from 'no forge', because only one is fixable here", async () => {
    const forge = await openStackForge(
      "/repo",
      deps({ remotes: [remote("origin", "https://github.com/acme/app")], octokit: null })
    )
    expect(forge).toEqual({ status: "noCredential", repository: "acme/app", remote: "origin" })
  })

  it("treats a credential lookup that throws as no credential", async () => {
    const forge = await openStackForge(
      "/repo",
      deps({
        remotes: [remote("origin", "https://github.com/acme/app")],
        octokit: () => Promise.reject(new Error("gh: not logged in")),
      })
    )
    expect(forge).toMatchObject({ status: "noCredential" })
  })

  it("survives a repository whose remotes cannot be read", async () => {
    const forge = await openStackForge("/repo", {
      remotes: () => Promise.reject(new Error("not a repository")),
    })
    expect(forge).toEqual({ status: "noRemote" })
  })
})
