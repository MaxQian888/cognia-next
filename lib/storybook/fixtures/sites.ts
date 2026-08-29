/**
 * Storybook fixtures for the Sites console.
 *
 * Sites is desktop-only and sits behind the shell's account gate, so Storybook
 * is the only place these components can be looked at without a real Cloudflare
 * account and a built project.
 */
import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

const NOW = 1_756_000_000_000

export function makeSite(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_docs",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/Users/dev/cognia",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "acct_1", workerName: "cognia-docs", zoneId: "zone_1" },
    authoringPolicy: {
      ownerAccountId: "owner",
      editorAccountIds: ["teammate"],
      deployerAccountIds: [],
    },
    visitorPolicy: { mode: "private" },
    providerTokenState: {
      executionTargetKey: "local",
      status: "verified",
      verifiedAt: NOW - 8_000,
    },
    lifecycle: "active",
    createdAt: NOW - 900_000,
    updatedAt: NOW - 4_000,
    ...overrides,
  }
}

export function makeVersion(overrides: Partial<SiteVersionRow> = {}): SiteVersionRow {
  return {
    id: "ver_3",
    siteId: "site_docs",
    sequence: 3,
    status: "ready",
    environmentRevisionId: "env_2",
    source: {
      commitSha: "9f3c1ab8e2",
      dirty: false,
      lockfileDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
    },
    build: {
      command: '["pnpm","build"]',
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: ["nodejs_compat"],
      routes: [],
      bindings: [{ kind: "d1", name: "DB", resourceId: "d1_1" }],
      installNetworkHosts: ["registry.npmjs.org"],
      buildNetworkHosts: [],
    },
    artifactDigest: "c".repeat(64),
    artifactSize: 3_244_032,
    artifactFileCount: 128,
    createdAt: NOW - 60_000,
    completedAt: NOW - 42_000,
    ...overrides,
  }
}

/** A finished build, a failure with its message, and one still running. */
export function makeVersionSet(): SiteVersionRow[] {
  return [
    makeVersion(),
    makeVersion({
      id: "ver_2",
      sequence: 2,
      status: "failed",
      artifactDigest: undefined,
      artifactSize: undefined,
      artifactFileCount: undefined,
      failureMessage: "TS2304: Cannot find name 'Analytics'.",
      createdAt: NOW - 400_000,
      completedAt: NOW - 380_000,
    }),
    makeVersion({
      id: "ver_1",
      sequence: 1,
      status: "building",
      artifactDigest: undefined,
      artifactSize: undefined,
      artifactFileCount: undefined,
      completedAt: undefined,
      createdAt: NOW - 800_000,
    }),
  ]
}

export function makeDeployment(overrides: Partial<SiteDeploymentRow> = {}): SiteDeploymentRow {
  return {
    id: "dep_3",
    siteId: "site_docs",
    versionId: "ver_3",
    environmentRevisionId: "env_2",
    status: "active",
    providerDeploymentId: "cf_dep_3",
    productionUrl: "https://docs.cognia.dev",
    createdAt: NOW - 40_000,
    updatedAt: NOW - 38_000,
    ...overrides,
  }
}

export function makeOperation(overrides: Partial<SiteOperationRow> = {}): SiteOperationRow {
  return {
    id: "op_3",
    siteId: "site_docs",
    type: "deploy",
    executionTargetKey: "local",
    idempotencyKey: "deploy:site_docs:ver_3",
    inputDigest: "d".repeat(64),
    status: "succeeded",
    attemptCount: 1,
    providerRequestId: "cf-req-7d2",
    createdAt: NOW - 40_000,
    updatedAt: NOW - 38_000,
    completedAt: NOW - 38_000,
    ...overrides,
  }
}

/** One success, one failure with its message, one waiting on reconciliation. */
export function makeOperationSet(): SiteOperationRow[] {
  return [
    makeOperation(),
    makeOperation({
      id: "op_2",
      type: "build",
      idempotencyKey: "build:site_docs:ver_2",
      status: "failed",
      attemptCount: 2,
      errorMessage: "TS2304: Cannot find name 'Analytics'.",
      updatedAt: NOW - 380_000,
    }),
    makeOperation({
      id: "op_1",
      type: "domain",
      idempotencyKey: "domain:add:site_docs",
      status: "waiting-reconcile",
      errorMessage: "Cloudflare did not confirm the attachment.",
      updatedAt: NOW - 500_000,
    }),
  ]
}

export function makeResourceSet(): SiteResourceRow[] {
  return [
    {
      id: "res_worker",
      siteId: "site_docs",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "cognia-docs",
      displayName: "cognia-docs",
      ownership: "managed",
      status: "active",
      dependencies: [],
      createdAt: NOW - 800_000,
      updatedAt: NOW - 800_000,
    },
    {
      id: "res_domain",
      siteId: "site_docs",
      provider: "cloudflare",
      kind: "custom-domain",
      providerResourceId: "cf_domain_1",
      displayName: "docs.cognia.dev",
      metadata: { zoneId: "zone_1" },
      ownership: "managed",
      status: "active",
      dependencies: ["res_worker"],
      createdAt: NOW - 700_000,
      updatedAt: NOW - 700_000,
    },
    {
      id: "res_d1",
      siteId: "site_docs",
      provider: "cloudflare",
      kind: "d1-database",
      providerResourceId: "d1_1",
      displayName: "docs-db",
      ownership: "adopted",
      status: "active",
      dependencies: [],
      createdAt: NOW - 800_000,
      updatedAt: NOW - 800_000,
    },
  ]
}

export const ALLOWED_GATE = { allowed: true, reason: "ok" as const, title: undefined }
export const BLOCKED_GATE = {
  allowed: false,
  reason: "requires-desktop" as const,
  title: "Available in the Cognia desktop app",
}
