import type { StepExecutionContext } from "@/types/workflow/visual"

let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

let unlockedAccountId: string | null = "owner"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ unlockedAccountId }) },
}))

const buildAndSaveSiteVersion = jest.fn(async () => ({
  id: "ver_1",
  sequence: 3,
  status: "ready",
  source: { commitSha: "abc1234", dirty: false },
  artifactDigest: "d",
}))
jest.mock("@/lib/sites/build-version", () => ({
  buildAndSaveSiteVersion: (...args: unknown[]) => buildAndSaveSiteVersion(...args),
}))

const publishSiteVersion = jest.fn(async () => ({
  id: "dep_1",
  versionId: "ver_1",
  status: "active",
  productionUrl: "https://docs.example.com",
  updatedAt: 5,
}))
jest.mock("@/lib/sites/publish-version", () => ({
  publishSiteVersion: (...args: unknown[]) => publishSiteVersion(...args),
}))

const deployVersion = jest.fn(async () => ({
  id: "dep_2",
  versionId: "ver_old",
  status: "active",
  updatedAt: 9,
}))
jest.mock("@/lib/sites/cloudflare/service", () => ({
  CloudflareSitesService: jest.fn(function (this: Record<string, unknown>) {
    this.deployVersion = deployVersion
  }),
}))

const db = {
  getSiteProject: jest.fn(async () => ({ id: "site_1", name: "Docs", lifecycle: "active" })),
  listSiteVersions: jest.fn(async () => [] as unknown[]),
  listSiteDeployments: jest.fn(async () => [] as unknown[]),
  listSiteOperations: jest.fn(async () => [] as unknown[]),
  listSiteEnvironmentRevisions: jest.fn(async () => [{ id: "env_1", sequence: 1 }]),
}
jest.mock("@/lib/db/sites", () => ({
  getSiteProject: (...a: unknown[]) => db.getSiteProject(...a),
  listSiteVersions: (...a: unknown[]) => db.listSiteVersions(...a),
  listSiteDeployments: (...a: unknown[]) => db.listSiteDeployments(...a),
  listSiteOperations: (...a: unknown[]) => db.listSiteOperations(...a),
  listSiteEnvironmentRevisions: (...a: unknown[]) => db.listSiteEnvironmentRevisions(...a),
}))

import "./index"
import { getExecutor } from "../registry"

function run(kind: string, params: Record<string, unknown>) {
  const registered = getExecutor(kind as never, 1)
  if (!registered) throw new Error(`no executor for ${kind}`)
  return registered.execute({ params } as unknown as StepExecutionContext)
}

const READY = {
  id: "ver_1",
  sequence: 3,
  status: "ready",
  source: { commitSha: "abc1234", dirty: false },
  artifactDigest: "d",
}

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
  unlockedAccountId = "owner"
  db.listSiteVersions.mockResolvedValue([])
  db.listSiteDeployments.mockResolvedValue([])
  db.listSiteOperations.mockResolvedValue([])
  db.listSiteEnvironmentRevisions.mockResolvedValue([{ id: "env_1", sequence: 1 }])
})

describe("host and actor gating", () => {
  it.each(["action.site.build", "action.site.deploy", "action.site.rollback"])(
    "%s refuses off the desktop, before reading a param",
    async (kind) => {
      tauri = false
      await expect(run(kind, {})).rejects.toThrow(/needs the desktop app/)
      expect(db.listSiteVersions).not.toHaveBeenCalled()
    }
  )

  it.each(["action.site.build", "action.site.deploy", "action.site.rollback"])(
    "%s refuses with a locked vault rather than defaulting the actor",
    async (kind) => {
      // A workflow author who could name an account would make
      // `assertSiteAuthoringCapability` pass for whatever they typed.
      unlockedAccountId = null
      await expect(run(kind, { siteId: "site_1" })).rejects.toThrow(/unlock your account/)
    }
  )

  it("does not accept an actor as a node param", async () => {
    unlockedAccountId = null
    await expect(
      run("action.site.build", { siteId: "site_1", actorAccountId: "someone-else" })
    ).rejects.toThrow(/unlock your account/)
  })

  it.each([
    "action.site.build",
    "action.site.deploy",
    "action.site.rollback",
    "action.site.status",
  ])("%s requires a siteId", async (kind) => {
    await expect(run(kind, {})).rejects.toThrow(/siteId is required/)
  })
})

describe("action.site.build", () => {
  it("builds against the newest environment revision", async () => {
    db.listSiteEnvironmentRevisions.mockResolvedValue([
      { id: "env_1", sequence: 1 },
      { id: "env_2", sequence: 2 },
    ])
    const out = await run("action.site.build", { siteId: "site_1" })
    expect(buildAndSaveSiteVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site_1",
        environmentRevisionId: "env_2",
        actorAccountId: "owner",
      })
    )
    expect(out.output).toMatchObject({ id: "ver_1", sequence: 3, status: "ready" })
  })

  it("says what is missing when no environment exists", async () => {
    db.listSiteEnvironmentRevisions.mockResolvedValue([])
    await expect(run("action.site.build", { siteId: "site_1" })).rejects.toThrow(
      /save an environment revision/
    )
  })

  it("never inherits a default build-phase network allowance", async () => {
    // ADR-0084's fail-closed rule: an unattended build reaching the network is
    // a decision, not an inherited convenience.
    await run("action.site.build", { siteId: "site_1" })
    expect(buildAndSaveSiteVersion.mock.calls[0][0]).toMatchObject({ buildNetworkHosts: [] })
  })

  it("passes the named runtime and hosts through", async () => {
    await run("action.site.build", {
      siteId: "site_1",
      runtime: "node@22",
      packageManager: "yarn@4",
      installNetworkHosts: ["registry.internal"],
      buildNetworkHosts: ["api.example.com"],
    })
    expect(buildAndSaveSiteVersion.mock.calls[0][0]).toMatchObject({
      runtime: "node@22",
      packageManager: "yarn@4",
      installNetworkHosts: ["registry.internal"],
      buildNetworkHosts: ["api.example.com"],
    })
  })
})

describe("action.site.deploy", () => {
  it("publishes the newest ready version when none is named", async () => {
    db.listSiteVersions.mockResolvedValue([READY])
    const out = await run("action.site.deploy", { siteId: "site_1" })
    expect(publishSiteVersion).toHaveBeenCalledWith({
      siteId: "site_1",
      versionId: "ver_1",
      actorAccountId: "owner",
    })
    expect(out.output).toMatchObject({ productionUrl: "https://docs.example.com" })
  })

  it("publishes the version a link names", async () => {
    db.listSiteVersions.mockResolvedValue([READY, { ...READY, id: "ver_2", sequence: 4 }])
    await run("action.site.deploy", { siteId: "site_1", versionId: "ver_2" })
    expect(publishSiteVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: "ver_2" }))
  })

  it("refuses when nothing is ready, rather than publishing a failed build", async () => {
    db.listSiteVersions.mockResolvedValue([{ ...READY, status: "failed" }])
    await expect(run("action.site.deploy", { siteId: "site_1" })).rejects.toThrow(
      /no ready version to publish/
    )
  })
})

describe("action.site.rollback", () => {
  it("redeploys the newest superseded version of a different build", async () => {
    db.listSiteDeployments.mockResolvedValue([
      { id: "d1", versionId: "ver_old", status: "superseded", updatedAt: 2 },
      { id: "d2", versionId: "ver_older", status: "superseded", updatedAt: 1 },
      { id: "d3", versionId: "ver_new", status: "active", updatedAt: 3 },
    ])
    const out = await run("action.site.rollback", { siteId: "site_1" })
    expect(deployVersion).toHaveBeenCalledWith("site_1", "ver_old")
    expect(out.output).toMatchObject({ rolledBackTo: "ver_old" })
  })

  it("never redeploys the version already serving — that is not a rollback", async () => {
    db.listSiteDeployments.mockResolvedValue([
      { id: "d1", versionId: "ver_new", status: "superseded", updatedAt: 1 },
      { id: "d2", versionId: "ver_new", status: "active", updatedAt: 3 },
    ])
    await expect(run("action.site.rollback", { siteId: "site_1" })).rejects.toThrow(
      /no earlier version live/
    )
  })

  it("refuses when nothing has ever served", async () => {
    await expect(run("action.site.rollback", { siteId: "site_1" })).rejects.toThrow(
      /no earlier version live/
    )
  })
})

describe("action.site.status", () => {
  it("answers off the desktop, so a flow can report what it could not do", async () => {
    tauri = false
    const out = await run("action.site.status", { siteId: "site_1" })
    expect(out.output).toMatchObject({ id: "site_1", name: "Docs", lifecycle: "active" })
  })

  it("reports the live URL, the current version, and unresolved failures", async () => {
    db.listSiteVersions.mockResolvedValue([
      READY,
      { ...READY, id: "ver_bad", sequence: 4, status: "failed", failureMessage: "exit 1" },
    ])
    db.listSiteDeployments.mockResolvedValue([
      {
        id: "d1",
        versionId: "ver_1",
        status: "active",
        productionUrl: "https://docs.example.com",
        updatedAt: 5,
      },
    ])
    db.listSiteOperations.mockResolvedValue([
      { id: "op_1", type: "build", status: "running", updatedAt: 6 },
    ])
    const out = await run("action.site.status", { siteId: "site_1" })
    expect(out.output).toMatchObject({
      productionUrl: "https://docs.example.com",
      readyVersions: 1,
      running: true,
    })
    expect((out.output as { currentVersion: { id: string } }).currentVersion.id).toBe("ver_1")
    expect((out.output as { failures: unknown[] }).failures).toHaveLength(1)
  })

  it("says the Site is missing rather than returning an empty shape", async () => {
    db.getSiteProject.mockResolvedValue(undefined as never)
    await expect(run("action.site.status", { siteId: "ghost" })).rejects.toThrow(/Site not found/)
  })
})

describe("registration", () => {
  it.each(["action.site.build", "action.site.deploy", "action.site.rollback"])(
    "%s is not retryable",
    (kind) => {
      // A retry re-queues under the same idempotency key; `queueSiteOperation`
      // returns the existing row and `runOperation` throws "requires
      // reconciliation". An automatic retry can never succeed.
      expect(getExecutor(kind as never, 1)?.retryable).toBe(false)
    }
  )

  it("gives the long operations a timeout that outlasts their own lease", () => {
    expect(getExecutor("action.site.build" as never, 1)?.timeoutMs).toBeGreaterThan(60 * 60_000)
  })
})
