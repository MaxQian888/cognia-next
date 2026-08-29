import { buildSiteStats } from "./site-stats"
import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

function version(over: Partial<SiteVersionRow> & Pick<SiteVersionRow, "id">): SiteVersionRow {
  return {
    siteId: "s1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env",
    source: { commitSha: "a", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-01-01",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    artifactDigest: `d-${over.id}`,
    artifactSize: 1024,
    artifactFileCount: 2,
    createdAt: 1,
    ...over,
  }
}

const EMPTY = { versions: [], deployments: [], operations: [], resources: [] }
const keys = (input: Parameters<typeof buildSiteStats>[0]) =>
  buildSiteStats(input).map((stat) => stat.key)

it("shows nothing at all for a Site that has done nothing", () => {
  // A strip of zeros reads as a value that failed to load rather than one that
  // does not apply yet.
  expect(buildSiteStats(EMPTY)).toEqual([])
})

it("counts ready versions against the total, flagging failures", () => {
  const stats = buildSiteStats({
    ...EMPTY,
    versions: [
      version({ id: "a" }),
      version({ id: "b", status: "failed", artifactDigest: undefined }),
    ],
  })
  expect(stats[0]).toMatchObject({ key: "versions", value: "1/2", detail: "1", tone: "attention" })
})

it("reads positive when every build succeeded", () => {
  const stats = buildSiteStats({ ...EMPTY, versions: [version({ id: "a" })] })
  expect(stats[0]).toMatchObject({ value: "1/1", tone: "positive" })
  expect(stats[0]?.detail).toBeUndefined()
})

it("flags a Site whose deployments exist but none is serving", () => {
  const deployments = [
    {
      id: "d",
      siteId: "s1",
      versionId: "a",
      environmentRevisionId: "e",
      status: "failed",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as SiteDeploymentRow[]
  const stats = buildSiteStats({ ...EMPTY, deployments })
  expect(stats.find((stat) => stat.key === "live")).toMatchObject({
    value: "0",
    detail: "1",
    tone: "attention",
  })
})

it("stays quiet about operations until something is running or stuck", () => {
  const done = [{ id: "o", siteId: "s1", status: "succeeded" }] as SiteOperationRow[]
  expect(keys({ ...EMPTY, operations: done })).not.toContain("running")

  const stuck = [{ id: "o", siteId: "s1", status: "waiting-reconcile" }] as SiteOperationRow[]
  expect(
    buildSiteStats({ ...EMPTY, operations: stuck }).find((s) => s.key === "running")
  ).toMatchObject({
    detail: "1",
    tone: "attention",
  })
})

it("counts managed resources against everything the provider holds", () => {
  // Managed is what a purge deletes; the denominator is what exists.
  const resources = [
    { id: "1", siteId: "s1", ownership: "managed", status: "active" },
    { id: "2", siteId: "s1", ownership: "adopted", status: "active" },
    { id: "3", siteId: "s1", ownership: "managed", status: "deleted" },
  ] as SiteResourceRow[]
  expect(buildSiteStats({ ...EMPTY, resources }).find((s) => s.key === "resources")).toMatchObject({
    value: "1/2",
  })
})

it("reports the local archive footprint once bytes exist", () => {
  const stats = buildSiteStats({ ...EMPTY, versions: [version({ id: "a" })] })
  expect(stats.find((stat) => stat.key === "storage")).toMatchObject({ value: "1.0KB" })
})

it("omits the footprint when retention already took everything", () => {
  const stats = buildSiteStats({
    ...EMPTY,
    versions: [version({ id: "a", artifactCollectedAt: 5 })],
  })
  expect(
    keys({ ...EMPTY, versions: [version({ id: "a", artifactCollectedAt: 5 })] })
  ).not.toContain("storage")
  expect(stats.find((stat) => stat.key === "versions")).toBeDefined()
})
