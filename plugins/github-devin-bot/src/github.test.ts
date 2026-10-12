import { GITHUB_SLOT, parseWork, workId } from "./github"
import { fixture } from "./devin-bot.test-helpers"

it("binds every GitHub read and write to one credential slot", () => {
  expect(GITHUB_SLOT).toBe("github")
})
it("rejects cross-repository work", () => {
  const f = fixture()
  expect(() => parseWork({ ...f.work, repository: "attacker/repo" }, f.config.repository)).toThrow(
    "out-of-scope"
  )
})
it("deduplicates CI job deliveries by item mode and head", () => {
  const f = fixture("repair")
  expect(workId({ ...f.work, workflowRunId: 1 })).toEqual(workId({ ...f.work, workflowRunId: 2 }))
})

it.each([null, {}, { number: 0 }, { kind: "invalid" }, { mode: "repair" }, { revision: "" }])(
  "validates untrusted work %j",
  (patch) => {
    const f = fixture()
    expect(() =>
      parseWork(
        patch && Object.keys(patch).length ? { ...f.work, ...patch } : patch,
        f.config.repository
      )
    ).toThrow()
  }
)
