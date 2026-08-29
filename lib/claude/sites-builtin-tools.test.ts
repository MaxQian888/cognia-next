import {
  BUILD_SITE_TOOL_NAME,
  DEPLOY_SITE_TOOL_NAME,
  LIST_SITES_TOOL_NAME,
  buildSitesBuiltinManifestEntries,
  isSitesBuiltinTool,
  runSitesBuiltinTool,
  type SitesToolRunDeps,
} from "./sites-builtin-tools"

function deps(): SitesToolRunDeps {
  return {
    listSites: jest.fn(async () => [{ id: "site_1" }]),
    build: jest.fn(async () => ({ versionId: "ver_1" })),
    deploy: jest.fn(async () => ({ productionUrl: "https://x" })),
  }
}

it("surfaces exactly three tools, each owned by the Sites plugin id", () => {
  const entries = buildSitesBuiltinManifestEntries()
  expect(entries.map((entry) => entry.name)).toEqual([
    LIST_SITES_TOOL_NAME,
    BUILD_SITE_TOOL_NAME,
    DEPLOY_SITE_TOOL_NAME,
  ])
  expect(entries.every((entry) => entry.pluginId === "cognia-sites-builtin")).toBe(true)
})

it("tells the model that publishing cannot be undone", () => {
  // The description is the only place a model learns this before it acts.
  const deploy = buildSitesBuiltinManifestEntries().find(
    (entry) => entry.name === DEPLOY_SITE_TOOL_NAME
  )
  expect(deploy?.description).toMatch(/[Ii]rreversible/)
})

it("tells the model that building publishes nothing", () => {
  const build = buildSitesBuiltinManifestEntries().find(
    (entry) => entry.name === BUILD_SITE_TOOL_NAME
  )
  expect(build?.description).toMatch(/Publishes nothing/)
})

it("recognizes its own tools and nothing else", () => {
  expect(isSitesBuiltinTool(LIST_SITES_TOOL_NAME)).toBe(true)
  expect(isSitesBuiltinTool("read_active_editor")).toBe(false)
})

it("lists sites without any arguments", async () => {
  const d = deps()
  await expect(runSitesBuiltinTool(LIST_SITES_TOOL_NAME, {}, d)).resolves.toEqual([
    { id: "site_1" },
  ])
})

it("builds with no network unless the model names hosts", async () => {
  // ADR-0084's fail-closed rule: an agent reaching the network during a build
  // is a decision, not an inherited convenience.
  const d = deps()
  await runSitesBuiltinTool(BUILD_SITE_TOOL_NAME, { siteId: "site_1" }, d)
  expect(d.build).toHaveBeenCalledWith({ siteId: "site_1", buildNetworkHosts: [] })

  await runSitesBuiltinTool(
    BUILD_SITE_TOOL_NAME,
    { siteId: "site_1", buildNetworkHosts: ["api.example.com", 42] },
    d
  )
  expect(d.build).toHaveBeenLastCalledWith({
    siteId: "site_1",
    buildNetworkHosts: ["api.example.com"],
  })
})

it("deploys the newest ready version when none is named", async () => {
  const d = deps()
  await runSitesBuiltinTool(DEPLOY_SITE_TOOL_NAME, { siteId: "site_1" }, d)
  expect(d.deploy).toHaveBeenCalledWith({ siteId: "site_1" })
})

it("deploys the version the model named", async () => {
  const d = deps()
  await runSitesBuiltinTool(DEPLOY_SITE_TOOL_NAME, { siteId: "site_1", versionId: "ver_9" }, d)
  expect(d.deploy).toHaveBeenCalledWith({ siteId: "site_1", versionId: "ver_9" })
})

it.each([BUILD_SITE_TOOL_NAME, DEPLOY_SITE_TOOL_NAME])(
  "%s refuses without a siteId rather than guessing one",
  async (tool) => {
    await expect(runSitesBuiltinTool(tool, {}, deps())).rejects.toThrow(/siteId is required/)
    await expect(runSitesBuiltinTool(tool, { siteId: "  " }, deps())).rejects.toThrow(
      /siteId is required/
    )
  }
)

it("refuses a tool it does not own", async () => {
  await expect(runSitesBuiltinTool("purge_site", {}, deps())).rejects.toThrow(/unknown Sites tool/)
})
