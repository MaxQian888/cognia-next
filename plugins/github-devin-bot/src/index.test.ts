import definition, {
  createGithubDevinBot,
  githubDevinBot,
  githubDevinBotDef,
  manifest,
} from "./index"
import { fixture } from "./devin-bot.test-helpers"
import packagedManifest from "../plugin.json"

it("keeps the packaged and builtin manifest identical to the definition", () => {
  expect(JSON.parse(JSON.stringify(manifest))).toEqual(packagedManifest)
})

it("asks only for the permissions its host calls need and stays opt-in", () => {
  // workspace.acquire → filesystem:read + network:fetch; snapshot → git:read;
  // publish → filesystem:write + git:write + integrations:execute; bots.* →
  // agent:control; runExternalAgent → agent:dispatch-external.
  expect([...packagedManifest.permissions].sort()).toEqual(
    [
      "agent:control",
      "agent:dispatch-external",
      "filesystem:read",
      "filesystem:write",
      "git:read",
      "git:write",
      "integrations:execute",
      "network:fetch",
    ].sort()
  )
  expect(manifest.activationEvents).toBeUndefined()
})

it("ships no default repository and says it is github.com only", () => {
  const repository = githubDevinBotDef.configSchema.properties.repository
  expect(repository).not.toHaveProperty("default")
  expect(githubDevinBotDef.configSchema.required).toEqual(["repository"])
  expect(JSON.stringify(manifest)).not.toMatch(/NJUPT|sast-approval/)
  expect(manifest.description).toMatch(/GitHub Enterprise Server is not supported/)
  expect(githubDevinBotDef.description).toMatch(/GitHub Enterprise Server is not supported/)
  expect(manifest.bots).toEqual([githubDevinBotDef])
})

it("localizes the publication approval in English and Chinese", () => {
  const locales = packagedManifest.i18n.locales
  for (const key of [
    "approval.publishReview.title",
    "approval.publishPatch.title",
    "approval.publish.message",
  ]) {
    expect(locales.en[key as keyof typeof locales.en]).toBeTruthy()
    expect(locales["zh-CN"][key as keyof (typeof locales)["zh-CN"]]).toBeTruthy()
  }
})

it("declares bounded GitHub writes with grantable ceilings and defaults to disarmed monitoring", () => {
  expect(packagedManifest.dependencies["github-delivery"]).toBeDefined()
  expect(packagedManifest.runtimeCompatibility.headless).toMatchObject({
    availability: "supported",
    entrypoint: "dist/index.js",
  })
  expect(githubDevinBotDef.requires.integrationActions).toEqual([
    "github.openPr",
    "github.reviewPr",
  ])
  expect(githubDevinBotDef.policy).toMatchObject({
    maxAuthority: "bypassPermissions",
    maxAutonomy: "autopilot",
    allowSelfTriggering: false,
  })
  expect(githubDevinBotDef.policy).not.toHaveProperty("requireApprovalForWrites")
  expect(githubDevinBotDef.triggers.find((trigger) => trigger.id === "work")).toMatchObject({
    concurrencyKey: "github-work:{{resource.scope}}",
    holdConcurrencyWhileWaiting: false,
  })
  expect(
    githubDevinBotDef.triggers
      .filter((trigger) => trigger.kind === "poll" || trigger.kind === "event")
      .every((trigger) => trigger.enabledByDefault === false)
  ).toBe(true)
})
it("requires activation and drops the host context on deactivation", async () => {
  const f = fixture("review")
  expect(() => githubDevinBot(f.run)).toThrow("not active")
  await definition.activate(f.context)
  expect((await githubDevinBot(f.run))?.summary).toBe("Review published")
  await definition.deactivate?.(f.context)
  expect(() => githubDevinBot(f.run)).toThrow("not active")
})
it("rejects invalid configuration before dispatching capabilities", async () => {
  const f = fixture()
  f.run.config.model = "default"
  await expect(createGithubDevinBot(f.context)(f.run)).rejects.toThrow("Unsupported")
  expect(f.mocks.agent).not.toHaveBeenCalled()
})

it("dispatches monitor triggers through the shared handler without executing an agent", async () => {
  const f = fixture()
  f.run.event.triggerId = "scan"
  f.run.event.source = "manual"
  await createGithubDevinBot(f.context)(f.run)
  expect(f.mocks.enqueue).toHaveBeenCalled()
  expect(f.mocks.agent).not.toHaveBeenCalled()
})
