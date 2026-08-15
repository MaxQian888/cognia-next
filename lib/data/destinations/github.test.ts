/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

const settingsState: { current: Partial<AppSettings> } = { current: {} }
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settingsState.current,
  saveSettings: async (patch: Partial<AppSettings>) => {
    settingsState.current = { ...settingsState.current, ...patch }
    return settingsState.current
  },
}))
jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { export: stub, scheduler: stub }, createLogger: () => stub }
})

import { __setBackupDestinationSecretStoreForTesting } from "./config"
import {
  fetchGithubRepoInfo,
  uploadSnapshotToGithub,
  verifyGithubBackupDestination,
} from "./github"
import type { BackupHttpFn, BackupHttpRequest } from "./http"

class MemoryStore {
  data = new Map<string, string>()
  async save(k: string, v: string) {
    this.data.set(k, v)
  }
  async load(k: string) {
    return this.data.get(k) ?? null
  }
  async delete(k: string) {
    this.data.delete(k)
  }
}

const meta = { filename: "f", exportedAt: "2026-08-16T02:00:00.000Z", sizeBytes: 3 }
const config = {
  owner: "octo",
  repo: "vault",
  repoFullName: "octo/vault",
  path: "cognia-backups",
  credential: { kind: "keyring" as const },
}

/** Scripted GitHub API: records every request and answers by (method, path). */
function makeGithub(
  options: { isPrivate?: boolean; existingLatestSha?: string; entries?: unknown[] } = {}
) {
  const calls: BackupHttpRequest[] = []
  const http: BackupHttpFn = async (request) => {
    calls.push(request)
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/repos/octo/vault") {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          private: options.isPrivate ?? true,
          default_branch: "main",
          full_name: "octo/vault",
        }),
      }
    }
    if (
      request.method === "GET" &&
      url.pathname === "/repos/octo/vault/contents/cognia-backups/latest.enc.cbk"
    ) {
      return options.existingLatestSha
        ? { status: 200, headers: {}, body: JSON.stringify({ sha: options.existingLatestSha }) }
        : { status: 404, headers: {}, body: "{}" }
    }
    if (request.method === "GET" && url.pathname === "/repos/octo/vault/contents/cognia-backups") {
      return { status: 200, headers: {}, body: JSON.stringify(options.entries ?? []) }
    }
    if (request.method === "GET" && url.pathname.startsWith("/repos/octo/vault/contents/")) {
      return { status: 404, headers: {}, body: "{}" }
    }
    if (request.method === "PUT") {
      return { status: 201, headers: {}, body: JSON.stringify({ commit: { sha: "c0ffee" } }) }
    }
    if (request.method === "DELETE") {
      return { status: 200, headers: {}, body: "{}" }
    }
    return { status: 500, headers: {}, body: "unexpected" }
  }
  return { http, calls }
}

beforeEach(() => {
  __setBackupDestinationSecretStoreForTesting(new MemoryStore())
  settingsState.current = {
    backupAutoSchedule: { enabled: false, intervalDays: 7, retainCount: 2 },
    backupDestinations: { github: { enabled: true, repo: "octo/vault" } },
  }
})
afterAll(() => __setBackupDestinationSecretStoreForTesting(null))

describe("uploadSnapshotToGithub", () => {
  it("refuses when not configured or without a token", async () => {
    settingsState.current = { backupDestinations: {} }
    expect(await uploadSnapshotToGithub("b", meta, { http: makeGithub().http })).toMatchObject({
      ok: false,
      code: "not-configured",
    })
    settingsState.current = {
      backupDestinations: { github: { enabled: true, repo: "octo/vault" } },
    }
    expect(await uploadSnapshotToGithub("b", meta, { http: makeGithub().http })).toMatchObject({
      ok: false,
      code: "no-token",
    })
  })

  it("refuses public repositories before writing anything", async () => {
    const gh = makeGithub({ isPrivate: false })
    const result = await uploadSnapshotToGithub("b", meta, { http: gh.http, token: "t", config })
    expect(result).toMatchObject({ ok: false, code: "public-repo" })
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(0)
  })

  it("commits the snapshot + latest pointer, prunes beyond retainCount, stamps lastSyncAt", async () => {
    const gh = makeGithub({
      existingLatestSha: "old-sha",
      entries: [
        {
          type: "file",
          name: "cognia-backup-2026-08-10T00-00-00-000Z.enc.cbk",
          path: "cognia-backups/a",
          sha: "1",
        },
        {
          type: "file",
          name: "cognia-backup-2026-08-12T00-00-00-000Z.enc.cbk",
          path: "cognia-backups/b",
          sha: "2",
        },
        {
          type: "file",
          name: "cognia-backup-2026-08-16T02-00-00-000Z.enc.cbk",
          path: "cognia-backups/c",
          sha: "3",
        },
        { type: "file", name: "latest.enc.cbk", path: "cognia-backups/latest.enc.cbk", sha: "4" },
        { type: "dir", name: "cognia-backup-x.enc.cbk", path: "x", sha: "5" },
      ],
    })
    const result = await uploadSnapshotToGithub("body", meta, {
      http: gh.http,
      token: "t",
      config,
      now: () => Date.UTC(2026, 7, 16, 2, 0, 5),
    })
    expect(result).toEqual({
      ok: true,
      remotePath: "octo/vault:cognia-backups/cognia-backup-2026-08-16T02-00-00-000Z.enc.cbk",
      commitSha: "c0ffee",
    })
    const puts = gh.calls.filter((c) => c.method === "PUT")
    expect(puts.map((c) => new URL(c.url).pathname)).toEqual([
      "/repos/octo/vault/contents/cognia-backups/cognia-backup-2026-08-16T02-00-00-000Z.enc.cbk",
      "/repos/octo/vault/contents/cognia-backups/latest.enc.cbk",
    ])
    const latestBody = JSON.parse(puts[1].body ?? "{}")
    expect(latestBody).toMatchObject({ sha: "old-sha", branch: "main" })
    expect(Buffer.from(latestBody.content, "base64").toString("utf8")).toBe("body")
    // retainCount 2 → the oldest of the three timestamped snapshots is pruned.
    const deletes = gh.calls.filter((c) => c.method === "DELETE")
    expect(deletes.map((c) => new URL(c.url).pathname)).toEqual([
      "/repos/octo/vault/contents/cognia-backups/a",
    ])
    expect(settingsState.current.backupDestinations?.github?.lastSyncAt).toBe(
      "2026-08-16T02:00:05.000Z"
    )
    expect(settingsState.current.backupDestinations?.github?.lastVerifiedVisibility).toBe("private")
  })

  it("surfaces API failures with the GitHub message", async () => {
    const http: BackupHttpFn = async (request) =>
      request.method === "GET" && new URL(request.url).pathname === "/repos/octo/vault"
        ? {
            status: 200,
            headers: {},
            body: JSON.stringify({ private: true, default_branch: "main" }),
          }
        : { status: 422, headers: {}, body: JSON.stringify({ message: "Invalid request" }) }
    expect(await uploadSnapshotToGithub("b", meta, { http, token: "t", config })).toEqual({
      ok: false,
      code: "http",
      error: "Invalid request",
    })
    const failingRepo: BackupHttpFn = async () => ({
      status: 404,
      headers: {},
      body: JSON.stringify({ message: "Not Found" }),
    })
    expect(
      await uploadSnapshotToGithub("b", meta, { http: failingRepo, token: "t", config })
    ).toEqual({
      ok: false,
      code: "http",
      error: "Not Found",
    })
    const throwing: BackupHttpFn = async () => {
      throw new Error("offline")
    }
    expect(await uploadSnapshotToGithub("b", meta, { http: throwing, token: "t", config })).toEqual(
      {
        ok: false,
        code: "http",
        error: "offline",
      }
    )
  })

  it("verifyGithubBackupDestination records visibility and rejects public repos", async () => {
    expect(await verifyGithubBackupDestination({ http: makeGithub().http, token: "t" })).toEqual({
      ok: true,
      defaultBranch: "main",
    })
    expect(settingsState.current.backupDestinations?.github?.lastVerifiedVisibility).toBe("private")
    expect(
      await verifyGithubBackupDestination({
        http: makeGithub({ isPrivate: false }).http,
        token: "t",
      })
    ).toMatchObject({ ok: false, code: "public-repo" })
    expect(settingsState.current.backupDestinations?.github?.lastVerifiedVisibility).toBe("public")
    expect(await verifyGithubBackupDestination({ http: makeGithub().http })).toMatchObject({
      code: "no-token",
    })
    settingsState.current = { backupDestinations: {} }
    expect(await verifyGithubBackupDestination({ http: makeGithub().http })).toMatchObject({
      code: "not-configured",
    })
  })

  it("fetchGithubRepoInfo maps unexpected bodies", async () => {
    const weird: BackupHttpFn = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ nope: 1 }),
    })
    expect(await fetchGithubRepoInfo(config, "t", weird)).toMatchObject({
      ok: false,
      error: /Unexpected/,
    })
    const plain: BackupHttpFn = async () => ({ status: 503, headers: {}, body: "" })
    expect(await fetchGithubRepoInfo(config, "t", plain)).toMatchObject({ ok: false, status: 503 })
  })
})
