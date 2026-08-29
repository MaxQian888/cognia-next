import { makeProviderInput, makeTestContext } from "../testing"
import { createSitesProvider, loadSiteSearchRows, type SitesProviderDeps } from "./sites"
import type { SiteDeploymentRow, SiteProjectRow, SiteResourceRow } from "@/types/sites"

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "acc", workerName: "cognia-docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  }
}

function deployment(overrides: Partial<SiteDeploymentRow> = {}): SiteDeploymentRow {
  return {
    id: "dep_1",
    siteId: "site_1",
    versionId: "ver_1",
    environmentRevisionId: "env_1",
    status: "active",
    productionUrl: "https://cognia-docs.workers.dev",
    createdAt: 1,
    updatedAt: 5,
    ...overrides,
  }
}

function domain(displayName: string): SiteResourceRow {
  return {
    id: `res_${displayName}`,
    siteId: "site_1",
    provider: "cloudflare",
    kind: "custom-domain",
    providerResourceId: "cf_1",
    displayName,
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 1,
    updatedAt: 1,
  } as SiteResourceRow
}

function deps(overrides: Partial<SitesProviderDeps> = {}): SitesProviderDeps {
  return {
    listSites: jest.fn(async () => [site()]),
    listActiveDeployments: jest.fn(async () => [deployment()]),
    listResources: jest.fn(async () => []),
    ...overrides,
  } as unknown as SitesProviderDeps
}

async function search(query: string, d: SitesProviderDeps = deps()) {
  return createSitesProvider(d).search(makeProviderInput(query), makeTestContext())
}

describe("loadSiteSearchRows", () => {
  it("never reads siteVersions", async () => {
    // A provider runs on every keystroke, and `siteVersions` is the largest
    // Sites table: a bare integer needle would match every Site's build history.
    const d = deps()
    await loadSiteSearchRows(d)
    expect(Object.keys(d)).toEqual(["listSites", "listActiveDeployments", "listResources"])
  })

  it("excludes a purged Site whose metadata is still around", async () => {
    const rows = await loadSiteSearchRows(
      deps({ listSites: jest.fn(async () => [site({ lifecycle: "deleted" })]) } as never)
    )
    expect(rows).toEqual([])
  })

  it("survives a Dexie read that throws rather than breaking the palette", async () => {
    const rows = await loadSiteSearchRows(
      deps({ listSites: jest.fn(async () => Promise.reject(new Error("closed"))) } as never)
    )
    expect(rows).toEqual([])
  })

  it("takes the newest active deployment's URL", async () => {
    const rows = await loadSiteSearchRows(
      deps({
        listActiveDeployments: jest.fn(async () => [
          deployment({ id: "old", productionUrl: "https://old.example", updatedAt: 1 }),
          deployment({ id: "new", productionUrl: "https://new.example", updatedAt: 9 }),
        ]),
      } as never)
    )
    expect(rows[0]?.productionUrl).toBe("https://new.example")
  })
})

describe("sites provider", () => {
  it("finds a Site by the name it was given", async () => {
    const out = await search("docs")
    expect(out.items[0]).toMatchObject({
      id: "site:site_1",
      kind: "site",
      title: "Docs",
      action: { type: "navigate", href: "/sites?site=site_1" },
    })
  })

  it("finds it by its worker name", async () => {
    const out = await search("cognia-docs")
    expect(out.items).toHaveLength(1)
  })

  it("finds it by a production hostname, which is what people remember", async () => {
    const out = await search("workers.dev")
    expect(out.items).toHaveLength(1)
  })

  it("finds it by an attached custom domain", async () => {
    const out = await search(
      "myapp.example.com",
      deps({ listResources: jest.fn(async () => [domain("myapp.example.com")]) } as never)
    )
    expect(out.items).toHaveLength(1)
  })

  it("ignores a domain the provider no longer has", async () => {
    const out = await search(
      "gone.example.com",
      deps({
        listResources: jest.fn(async () => [{ ...domain("gone.example.com"), status: "deleted" }]),
      } as never)
    )
    expect(out.items).toEqual([])
  })

  it("shows the live URL rather than the worker name once there is one", async () => {
    const out = await search("docs")
    expect(out.items[0]?.subtitle).toBe("https://cognia-docs.workers.dev")
  })

  it("falls back to the worker name before anything is deployed", async () => {
    const out = await search(
      "docs",
      deps({ listActiveDeployments: jest.fn(async () => []) } as never)
    )
    expect(out.items[0]?.subtitle).toBe("cognia-docs")
  })
})
