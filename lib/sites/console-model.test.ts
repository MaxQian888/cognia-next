import {
  SITE_RESOURCE_KIND_ORDER,
  collectSiteFailures,
  countVersionsByStatus,
  currentVersion,
  environmentDiffIsEmpty,
  environmentRevisionDiff,
  filterVersionViews,
  groupResourcesByKind,
  joinVersionsWithDeployments,
  latestEnvironmentRevision,
  operationFailureText,
  pickActiveDeployment,
  purgeRetentionReport,
  resolveSiteRailHint,
  siteAccessLoginUrl,
  siteAccessTeamMissing,
  siteIsAccessProtected,
  siteAnalyticsIsZoneScoped,
  siteObservabilityHostname,
  siteProductionUrl,
  siteRoleCapabilities,
  secretDiffIsEmpty,
  secretRevisionDiff,
  siteTokenStanding,
  siteViewerRole,
  sortEnvironmentRevisions,
} from "./console-model"
import { canAuthorSite } from "./authoring-policy"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

function version(overrides: Partial<SiteVersionRow> & Pick<SiteVersionRow, "id">): SiteVersionRow {
  return {
    siteId: "site_1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "abc1234", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-08-19",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    createdAt: 1,
    ...overrides,
  }
}

function deployment(
  overrides: Partial<SiteDeploymentRow> & Pick<SiteDeploymentRow, "id">
): SiteDeploymentRow {
  return {
    siteId: "site_1",
    versionId: "v1",
    environmentRevisionId: "env_1",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function resource(
  overrides: Partial<SiteResourceRow> & Pick<SiteResourceRow, "id" | "kind">
): SiteResourceRow {
  return {
    siteId: "site_1",
    provider: "cloudflare",
    providerResourceId: overrides.id,
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function operation(
  overrides: Partial<SiteOperationRow> & Pick<SiteOperationRow, "id">
): SiteOperationRow {
  return {
    siteId: "site_1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: overrides.id,
    inputDigest: "d",
    status: "succeeded",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function revision(
  overrides: Partial<SiteEnvironmentRevisionRow> & Pick<SiteEnvironmentRevisionRow, "id">
): SiteEnvironmentRevisionRow {
  return {
    siteId: "site_1",
    sequence: 1,
    variables: {},
    secretRefs: [],
    createdAt: 1,
    ...overrides,
  }
}

describe("deployment projections", () => {
  const rows = [
    deployment({ id: "d1", versionId: "v1", status: "superseded", updatedAt: 10 }),
    deployment({
      id: "d2",
      versionId: "v2",
      updatedAt: 20,
      productionUrl: "https://a.workers.dev",
    }),
    deployment({
      id: "d3",
      versionId: "v3",
      updatedAt: 15,
      productionUrl: "https://b.workers.dev",
    }),
  ]

  it("picks the newest active deployment, ignoring superseded ones", () => {
    expect(pickActiveDeployment(rows)?.id).toBe("d2")
  })

  it("surfaces the production URL of the active deployment", () => {
    expect(siteProductionUrl(rows)).toBe("https://a.workers.dev")
    expect(siteProductionUrl([])).toBeUndefined()
    expect(siteProductionUrl([deployment({ id: "d", status: "failed" })])).toBeUndefined()
  })

  it("resolves the version currently serving traffic", () => {
    const versions = [version({ id: "v1" }), version({ id: "v2", sequence: 2 })]
    expect(currentVersion(versions, rows)?.id).toBe("v2")
    expect(currentVersion(versions, [])).toBeUndefined()
  })
})

describe("siteViewerRole", () => {
  const policy = {
    ownerAccountId: "owner",
    editorAccountIds: ["editor", "both"],
    deployerAccountIds: ["deployer", "both"],
  }

  it("ranks owner above the lists and defaults to viewer", () => {
    expect(siteViewerRole(policy, "owner")).toBe("owner")
    expect(siteViewerRole(policy, "editor")).toBe("editor")
    expect(siteViewerRole(policy, "deployer")).toBe("deployer")
    expect(siteViewerRole(policy, "both")).toBe("editor")
    expect(siteViewerRole(policy, "stranger")).toBe("viewer")
  })

  it("reports capabilities that agree with canAuthorSite", () => {
    for (const accountId of ["owner", "editor", "deployer", "stranger"]) {
      const capabilities = siteRoleCapabilities(siteViewerRole(policy, accountId))
      for (const capability of ["view", "edit", "deploy", "manage"] as const) {
        expect(capabilities.includes(capability)).toBe(canAuthorSite(policy, accountId, capability))
      }
    }
  })
})

describe("failures", () => {
  it("reports the failure message the operation row carries", () => {
    expect(
      operationFailureText(operation({ id: "op1", status: "failed", errorMessage: "exit 1" }))
    ).toBe("exit 1")
    expect(
      operationFailureText(
        operation({ id: "op2", status: "waiting-reconcile", errorMessage: "provider timeout" })
      )
    ).toBe("provider timeout")
  })

  it("does not reach for events — both writers of these statuses set errorMessage", () => {
    // `failSiteOperation` and `markSiteOperationForReconcile` (lib/db/sites.ts)
    // are the only writers of `failed` / `waiting-reconcile`, and both set
    // `errorMessage` in the same transaction that appends the event. The old
    // events fallback was therefore unreachable, and reading it cost the
    // console every operation's events on every live-query re-run.
    expect(operationFailureText(operation({ id: "op3", status: "failed" }))).toBeUndefined()
  })

  it("stays silent for operations that did not fail", () => {
    expect(operationFailureText(operation({ id: "ok" }))).toBeUndefined()
    expect(operationFailureText(operation({ id: "run", status: "running" }))).toBeUndefined()
  })

  it("collects version, deployment, and operation failures newest first", () => {
    const failures = collectSiteFailures(
      [version({ id: "v1", status: "failed", failureMessage: "build broke", createdAt: 5 })],
      [deployment({ id: "d1", status: "failed", failureMessage: "deploy broke", updatedAt: 30 })],
      [operation({ id: "op1", status: "failed", errorMessage: "upload broke", updatedAt: 20 })],
      []
    )
    expect(failures.map((row) => row.scope)).toEqual(["deployment", "operation", "version"])
    expect(failures.map((row) => row.message)).toEqual([
      "deploy broke",
      "upload broke",
      "build broke",
    ])
  })

  it("ignores failed rows that carry no message", () => {
    expect(collectSiteFailures([version({ id: "v1", status: "failed" })], [], [], [])).toEqual([])
  })
})

describe("version views", () => {
  const versions = [
    version({ id: "v1", sequence: 1, status: "failed", failureMessage: "boom" }),
    version({ id: "v2", sequence: 2 }),
    version({ id: "v3", sequence: 3, status: "building" }),
  ]
  const deployments = [deployment({ id: "d1", versionId: "v2", updatedAt: 9 })]
  const resources = [resource({ id: "r1", kind: "worker-version", displayName: "v2" })]

  it("joins each version to its newest deployment and marks the live one", () => {
    const rows = joinVersionsWithDeployments(versions, deployments, resources)
    expect(rows.map((row) => row.version.id)).toEqual(["v3", "v2", "v1"])
    const live = rows.find((row) => row.version.id === "v2")
    expect(live?.live).toBe(true)
    expect(live?.uploaded).toBe(true)
    expect(live?.deployment?.id).toBe("d1")
    expect(rows.find((row) => row.version.id === "v1")?.uploaded).toBe(false)
  })

  it("keeps the newest deployment when a version was deployed more than once", () => {
    const rows = joinVersionsWithDeployments(versions, [
      deployment({ id: "old", versionId: "v2", status: "superseded", updatedAt: 1 }),
      deployment({ id: "new", versionId: "v2", updatedAt: 50 }),
    ])
    expect(rows.find((row) => row.version.id === "v2")?.deployment?.id).toBe("new")
  })

  it("filters by status and counts every bucket", () => {
    const rows = joinVersionsWithDeployments(versions, deployments, resources)
    expect(filterVersionViews(rows, "all")).toHaveLength(3)
    expect(filterVersionViews(rows, "failed").map((row) => row.version.id)).toEqual(["v1"])
    expect(countVersionsByStatus(versions)).toEqual({
      all: 3,
      ready: 1,
      building: 1,
      failed: 1,
    })
  })
})

describe("resources", () => {
  it("groups by kind in the declared order and drops empty groups", () => {
    const groups = groupResourcesByKind([
      resource({ id: "s1", kind: "secret" }),
      resource({ id: "w1", kind: "worker" }),
      resource({ id: "d1", kind: "custom-domain" }),
    ])
    expect(groups.map((group) => group.kind)).toEqual(["worker", "custom-domain", "secret"])
    expect(SITE_RESOURCE_KIND_ORDER).toHaveLength(8)
  })

  it("orders rows inside a group by creation time", () => {
    const groups = groupResourcesByKind([
      resource({ id: "b", kind: "worker-version", createdAt: 20 }),
      resource({ id: "a", kind: "worker-version", createdAt: 10 }),
    ])
    expect(groups[0].rows.map((row) => row.id)).toEqual(["a", "b"])
  })

  it("splits purge scope the way the service does", () => {
    const rows = [
      resource({ id: "m1", kind: "worker", ownership: "managed" }),
      resource({ id: "a1", kind: "d1-database", ownership: "adopted" }),
      resource({ id: "s1", kind: "r2-bucket", ownership: "shared" }),
      resource({ id: "gone", kind: "secret", ownership: "managed", status: "deleted" }),
    ]
    const report = purgeRetentionReport(rows)
    expect(report.purgeable.map((row) => row.id)).toEqual(["m1"])
    expect(report.retained.map((row) => row.id)).toEqual(["a1", "s1"])
  })
})

describe("observability", () => {
  it("prefers an active custom domain over the deployment host", () => {
    const hostname = siteObservabilityHostname(
      [resource({ id: "d", kind: "custom-domain", displayName: "docs.example.com" })],
      [deployment({ id: "dep", productionUrl: "https://worker.workers.dev" })]
    )
    expect(hostname).toBe("docs.example.com")
  })

  it("falls back to the newest deployment's host regardless of its status", () => {
    const hostname = siteObservabilityHostname(
      [],
      [
        deployment({ id: "old", productionUrl: "https://old.workers.dev", updatedAt: 1 }),
        deployment({
          id: "new",
          status: "superseded",
          productionUrl: "https://new.workers.dev",
          updatedAt: 9,
        }),
      ]
    )
    expect(hostname).toBe("new.workers.dev")
  })

  it("returns undefined when nothing names a host, including a malformed URL", () => {
    expect(siteObservabilityHostname([], [])).toBeUndefined()
    expect(
      siteObservabilityHostname([], [deployment({ id: "d", productionUrl: "not a url" })])
    ).toBeUndefined()
  })

  it("reports whether analytics will be zone-scoped", () => {
    expect(siteAnalyticsIsZoneScoped({ zoneId: "zone" })).toBe(true)
    expect(siteAnalyticsIsZoneScoped({ zoneId: "  " })).toBe(false)
    expect(siteAnalyticsIsZoneScoped({})).toBe(false)
  })
})

describe("environment", () => {
  const rows = [
    revision({ id: "e1", sequence: 1, variables: { A: "1", B: "2" } }),
    revision({ id: "e3", sequence: 3, variables: { A: "9" } }),
    revision({ id: "e2", sequence: 2 }),
  ]

  it("finds the newest revision by sequence and sorts the history newest first", () => {
    expect(latestEnvironmentRevision(rows)?.id).toBe("e3")
    expect(latestEnvironmentRevision([])).toBeUndefined()
    expect(sortEnvironmentRevisions(rows).map((row) => row.id)).toEqual(["e3", "e2", "e1"])
  })

  it("diffs a draft against the current revision", () => {
    const diff = environmentRevisionDiff(rows[0], { A: "1", B: "changed", C: "new" })
    expect(diff).toEqual({ added: ["C"], changed: ["B"], removed: [] })
    expect(environmentDiffIsEmpty(diff)).toBe(false)
  })

  it("reports every existing key as removed when the draft is empty", () => {
    expect(environmentRevisionDiff(rows[0], {})).toEqual({
      added: [],
      changed: [],
      removed: ["A", "B"],
    })
  })

  it("treats a first revision as pure additions and an identical draft as no change", () => {
    expect(environmentRevisionDiff(undefined, { A: "1" })).toEqual({
      added: ["A"],
      changed: [],
      removed: [],
    })
    expect(environmentDiffIsEmpty(environmentRevisionDiff(rows[0], { A: "1", B: "2" }))).toBe(true)
  })
})

describe("resolveSiteRailHint", () => {
  const target = { id: "site_1" }

  it("puts an in-flight operation above everything else", () => {
    const hint = resolveSiteRailHint(
      target,
      [deployment({ id: "d", updatedAt: 50 })],
      [operation({ id: "op", status: "running" })]
    )
    expect(hint).toEqual({ kind: "running", tone: "info", live: true })
  })

  it("reports a serving Site as live with the deployment time", () => {
    expect(resolveSiteRailHint(target, [deployment({ id: "d", updatedAt: 50 })], [])).toEqual({
      kind: "live",
      tone: "success",
      live: false,
      at: 50,
    })
  })

  it("does not shout failure at a Site that is serving traffic", () => {
    const hint = resolveSiteRailHint(
      target,
      [deployment({ id: "d", updatedAt: 50 })],
      [operation({ id: "op", status: "failed", updatedAt: 99 })]
    )
    expect(hint.kind).toBe("live")
  })

  it("flags a failure only when nothing has ever gone live", () => {
    expect(
      resolveSiteRailHint(target, [], [operation({ id: "op", status: "failed", updatedAt: 9 })])
    ).toEqual({ kind: "failed", tone: "danger", live: false, at: 9 })
    expect(
      resolveSiteRailHint(
        target,
        [],
        [operation({ id: "op", status: "waiting-reconcile", updatedAt: 9 })]
      ).kind
    ).toBe("failed")
  })

  it("ignores signals belonging to other Sites", () => {
    const hint = resolveSiteRailHint(
      target,
      [deployment({ id: "d", siteId: "site_2", updatedAt: 50 })],
      [operation({ id: "op", siteId: "site_2", status: "running" })]
    )
    expect(hint).toEqual({ kind: "never", tone: "neutral", live: false })
  })
})

describe("visitor access", () => {
  it("treats everything except public as behind Access", () => {
    expect(siteIsAccessProtected({ mode: "private" })).toBe(true)
    expect(siteIsAccessProtected({ mode: "identities", emails: [] })).toBe(true)
    expect(siteIsAccessProtected({ mode: "public" })).toBe(false)
  })

  it("builds the sign-in origin from a bare team name or a full domain", () => {
    expect(siteAccessLoginUrl({ accessTeamName: "acme" })).toBe("https://acme.cloudflareaccess.com")
    expect(siteAccessLoginUrl({ accessTeamName: "acme.cloudflareaccess.com" })).toBe(
      "https://acme.cloudflareaccess.com"
    )
    expect(siteAccessLoginUrl({ accessTeamName: "https://acme.example.com/" })).toBe(
      "https://acme.example.com"
    )
  })

  it("has no origin to offer without a team name", () => {
    expect(siteAccessLoginUrl({})).toBeUndefined()
    expect(siteAccessLoginUrl({ accessTeamName: "  " })).toBeUndefined()
  })

  it("only asks for the team name when the Site is actually protected", () => {
    expect(siteAccessTeamMissing({ mode: "private" }, {})).toBe(true)
    expect(siteAccessTeamMissing({ mode: "public" }, {})).toBe(false)
    expect(siteAccessTeamMissing({ mode: "private" }, { accessTeamName: "acme" })).toBe(false)
  })
})

describe("secretRevisionDiff", () => {
  const previous = {
    id: "e1",
    siteId: "site_1",
    sequence: 1,
    variables: {},
    secretRefs: [
      { key: "API_TOKEN", credentialId: "c1", revision: "r1" },
      { key: "DB_PASSWORD", credentialId: "c2", revision: "r2" },
    ],
    createdAt: 1,
  }

  it("labels each edit by what it does to the stored set", () => {
    expect(
      secretRevisionDiff(previous, [
        { key: "API_TOKEN", action: "keep" },
        { key: "DB_PASSWORD", action: "set", value: "x" },
        { key: "NEW", action: "set", value: "y" },
      ])
    ).toEqual({ kept: ["API_TOKEN"], replaced: ["DB_PASSWORD"], added: ["NEW"], removed: [] })
  })

  it("counts a stored key named by no edit as removed", () => {
    // Dropping by omission is exactly the silent wipe this model prevents; the
    // diff has to show it rather than let it pass as "unchanged".
    expect(secretRevisionDiff(previous, [{ key: "API_TOKEN", action: "keep" }]).removed).toEqual([
      "DB_PASSWORD",
    ])
  })

  it("treats an explicit removal and an omission the same way", () => {
    expect(
      secretRevisionDiff(previous, [
        { key: "API_TOKEN", action: "keep" },
        { key: "DB_PASSWORD", action: "remove" },
      ]).removed
    ).toEqual(["DB_PASSWORD"])
  })

  it("is empty only when every stored key is kept and nothing is added", () => {
    const untouched = secretRevisionDiff(previous, [
      { key: "API_TOKEN", action: "keep" },
      { key: "DB_PASSWORD", action: "keep" },
    ])
    expect(secretDiffIsEmpty(untouched)).toBe(true)
    expect(secretDiffIsEmpty(secretRevisionDiff(previous, []))).toBe(false)
  })

  it("treats every edit as an addition when there is no previous revision", () => {
    expect(secretRevisionDiff(undefined, [{ key: "NEW", action: "set", value: "v" }])).toEqual({
      kept: [],
      replaced: [],
      added: ["NEW"],
      removed: [],
    })
  })
})

describe("siteTokenStanding", () => {
  const base = { executionTargetKey: "local" }

  it("reports a verified credential on this host", () => {
    expect(
      siteTokenStanding({
        ...base,
        providerTokenState: { executionTargetKey: "local", status: "verified" },
      })
    ).toBe("verified")
  })

  it("separates a credential stored on another host from having none", () => {
    // The keyring is per machine. Telling someone to paste a token they already
    // saved elsewhere is a different instruction from telling them they never
    // saved one.
    expect(
      siteTokenStanding({
        ...base,
        providerTokenState: { executionTargetKey: "other", status: "verified" },
      })
    ).toBe("other-host")
    expect(siteTokenStanding({ ...base, providerTokenState: undefined })).toBe("missing")
  })

  it("reports a rejection", () => {
    expect(
      siteTokenStanding({
        ...base,
        providerTokenState: { executionTargetKey: "local", status: "rejected" },
      })
    ).toBe("rejected")
  })
})
