import { makeChangeset, makeHost, makeIntegration, makeReview } from "./test-fixtures"

it("keeps fixture evidence bound to the changeset and candidate", async () => {
  const changeset = makeChangeset({ review: makeReview() })
  const run = makeIntegration()
  const host = makeHost([changeset], [run])
  expect((await host.listChangesets())[0].review?.headSha).toBe(changeset.headSha)
  expect(await host.getChangeset("missing")).toBeNull()
  expect((await host.listIntegrations())[0].items[0].commitSha).toBe(run.candidateSha)
})
