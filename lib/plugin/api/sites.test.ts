/** @jest-environment jsdom */
const listSiteProjects = jest.fn(async () => [] as unknown[])
const listActiveSiteDeployments = jest.fn(async () => [] as unknown[])
const listSiteDeployments = jest.fn(async () => [] as unknown[])
jest.mock("@/lib/db/sites", () => ({
  listSiteProjects: () => listSiteProjects(),
  listActiveSiteDeployments: () => listActiveSiteDeployments(),
  listSiteDeployments: (...a: unknown[]) => listSiteDeployments(...a),
  listSiteVersions: jest.fn(async () => []),
  listSiteOperations: jest.fn(async () => []),
}))

import { getSiteProductionUrl, listSites } from "./sites"

const SITE = {
  id: "site_1",
  name: "Docs",
  projectId: "project_1",
  sourceRoot: "/Users/someone/private/repo",
  sourceSubpath: "apps/docs",
  executionTarget: { kind: "local" },
  executionTargetKey: "local",
  provider: "cloudflare",
  providerConfig: {
    accountId: "cf-account-secret",
    workerName: "docs",
    zoneId: "cf-zone-secret",
    accessTeamName: "acme",
  },
  authoringPolicy: {
    ownerAccountId: "owner@example.com",
    editorAccountIds: ["editor@example.com"],
    deployerAccountIds: [],
  },
  visitorPolicy: { mode: "domains", domains: ["acme.example.com"] },
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 2,
}

beforeEach(() => {
  jest.clearAllMocks()
  listSiteProjects.mockResolvedValue([SITE])
  listActiveSiteDeployments.mockResolvedValue([])
})

it("returns the identity a plugin needs", async () => {
  const [row] = await listSites()
  expect(row).toMatchObject({
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    workerName: "docs",
    lifecycle: "active",
    visitorMode: "domains",
  })
})

it("never hands a plugin the Cloudflare tenant identifiers", async () => {
  const serialized = JSON.stringify(await listSites())
  expect(serialized).not.toContain("cf-account-secret")
  expect(serialized).not.toContain("cf-zone-secret")
})

it("never hands a plugin the user's directory layout", async () => {
  const serialized = JSON.stringify(await listSites())
  expect(serialized).not.toContain("/Users/someone/private/repo")
  expect(serialized).not.toContain("apps/docs")
})

it("never hands a plugin the authoring policy's account ids", async () => {
  const serialized = JSON.stringify(await listSites())
  expect(serialized).not.toContain("owner@example.com")
  expect(serialized).not.toContain("editor@example.com")
})

it("flattens the visitor policy to its mode, not its identities or domains", async () => {
  // `identities` carries email addresses and `domains` carries allowed hosts.
  const serialized = JSON.stringify(await listSites())
  expect(serialized).not.toContain("acme.example.com")
  expect(serialized).toContain('"visitorMode":"domains"')
})

it("includes the live URL, which is public by definition", async () => {
  listActiveSiteDeployments.mockResolvedValue([
    { siteId: "site_1", productionUrl: "https://docs.example.com", updatedAt: 5 },
  ])
  expect((await listSites())[0]?.productionUrl).toBe("https://docs.example.com")
})

it("takes the newest active deployment's URL", async () => {
  listActiveSiteDeployments.mockResolvedValue([
    { siteId: "site_1", productionUrl: "https://old.example", updatedAt: 1 },
    { siteId: "site_1", productionUrl: "https://new.example", updatedAt: 9 },
  ])
  expect((await listSites())[0]?.productionUrl).toBe("https://new.example")
})

it("omits the URL entirely when nothing is deployed", async () => {
  expect((await listSites())[0]).not.toHaveProperty("productionUrl")
})

it("resolves one Site's production URL", async () => {
  listSiteDeployments.mockResolvedValue([
    {
      siteId: "site_1",
      versionId: "v",
      status: "active",
      productionUrl: "https://x",
      updatedAt: 1,
    },
  ])
  await expect(getSiteProductionUrl("site_1")).resolves.toBe("https://x")
})
