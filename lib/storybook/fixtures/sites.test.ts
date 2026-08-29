import {
  makeDeployment,
  makeOperationSet,
  makeResourceSet,
  makeSite,
  makeVersionSet,
} from "./sites"

// Fixtures are the only way to look at the Sites console — it is desktop-only
// and behind the account gate — so a fixture that has drifted from the row
// types shows a screen nobody will ever see.
it("builds a Site whose provider config and policy are complete", () => {
  const site = makeSite()
  expect(site.providerConfig.workerName).toBeTruthy()
  expect(site.authoringPolicy.ownerAccountId).toBeTruthy()
  expect(site.executionTarget.kind).toBe("local")
})

it("covers all three version states, which the versions tab renders differently", () => {
  expect(
    makeVersionSet()
      .map((version) => version.status)
      .sort()
  ).toEqual(["building", "failed", "ready"])
})

it("gives the failed version a message and no artifact", () => {
  const failed = makeVersionSet().find((version) => version.status === "failed")
  expect(failed?.failureMessage).toBeTruthy()
  expect(failed?.artifactDigest).toBeUndefined()
  expect(failed?.artifactSize).toBeUndefined()
})

it("gives the ready version the denormalized artifact summary", () => {
  const ready = makeVersionSet().find((version) => version.status === "ready")
  expect(ready?.artifactSize).toBeGreaterThan(0)
  expect(ready?.artifactFileCount).toBeGreaterThan(0)
})

it("covers a success, a failure with its message, and a stuck operation", () => {
  const operations = makeOperationSet()
  expect(operations.map((operation) => operation.status).sort()).toEqual([
    "failed",
    "succeeded",
    "waiting-reconcile",
  ])
  for (const operation of operations) {
    if (operation.status === "succeeded") continue
    expect(operation.errorMessage).toBeTruthy()
  }
})

it("covers both ownerships, so the purge-scope channel has something to show", () => {
  const ownerships = new Set(makeResourceSet().map((row) => row.ownership))
  expect(ownerships.has("managed")).toBe(true)
  expect(ownerships.has("adopted")).toBe(true)
})

it("points the deployment at a version the version set actually contains", () => {
  const deployment = makeDeployment()
  expect(makeVersionSet().some((version) => version.id === deployment.versionId)).toBe(true)
  expect(deployment.productionUrl).toMatch(/^https:\/\//)
})
