import definition, { createGithubDevinBot, githubDevinBot, manifest } from "./index"
import { fixture } from "./test-fixtures"

it("declares only approval-gated GitHub writes and defaults to disarmed monitoring", () => {
  expect(manifest.dependencies["github-delivery"]).toBeDefined()
  expect(manifest.runtimeCompatibility.headless).toMatchObject({
    availability: "supported",
    entrypoint: "dist/index.js",
  })
  expect(manifest.bots[0].requires.integrationActions).toEqual(["github.openPr", "github.reviewPr"])
  expect(manifest.bots[0].triggers.find((trigger) => trigger.id === "work")).toMatchObject({
    concurrencyKey: "github-work:{{resource.scope}}",
    holdConcurrencyWhileWaiting: false,
  })
  expect(
    manifest.bots[0].triggers
      .filter((trigger) => trigger.kind === "poll" || trigger.kind === "event")
      .every((trigger) => trigger.enabledByDefault === false)
  ).toBe(true)
})
it("requires activation and drops the host context on deactivation", async () => {
  const f = fixture("review")
  expect(() => githubDevinBot(f.run)).toThrow("not active")
  await definition.activate(f.context)
  expect((await githubDevinBot(f.run))?.summary).toBe("Review published")
  await definition.deactivate?.()
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
