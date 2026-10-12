import { currentCiExecutions, currentCiFailures, failedConclusion } from "./ci"

const SHA = "a".repeat(40)

it("selects only current-SHA latest attempts while preserving genuinely pending checks", () => {
  const run = { id: 1, workflow_id: 9, head_sha: SHA, status: "in_progress", conclusion: null }
  const check = {
    id: 1,
    app: { id: 9 },
    name: "test",
    head_sha: SHA,
    status: "in_progress",
    conclusion: null,
  }
  const executions = currentCiExecutions(
    [
      { ...run, run_attempt: 1 },
      { ...run, run_attempt: 2, status: "completed", conclusion: "success" },
      { ...run, id: 2, head_sha: "old" },
    ],
    [
      check,
      { ...check, id: 2, status: "completed", conclusion: "success" },
      { ...check, id: 3, name: "lint", status: "queued" },
      { ...check, id: 4, head_sha: "old" },
    ],
    SHA
  )
  expect(executions).toMatchObject({
    workflows: [{ id: 1, run_attempt: 2, status: "completed" }],
    checks: [
      { id: 3, name: "lint", status: "queued" },
      { id: 2, status: "completed" },
    ],
  })
})

it("ignores old CI failures after successful or pending reruns and keeps distinct checks", () => {
  const run = { id: 1, workflow_id: 9, head_sha: SHA, status: "completed", conclusion: "failure" }
  const check = {
    id: 1,
    app: { id: 8 },
    name: "test",
    head_sha: SHA,
    status: "completed",
    conclusion: "failure",
  }
  expect(
    currentCiFailures(
      [
        run,
        { ...run, id: 2, conclusion: "success" },
        { ...run, id: 3, head_sha: "old" },
        { ...run, id: 4, workflow_id: 10, status: "in_progress" },
        { ...run, id: 5, workflow_id: 10 },
        { ...run, id: 6, workflow_id: 11, run_attempt: 1 },
        { ...run, id: 6, workflow_id: 11, run_attempt: 2, conclusion: "success" },
        { ...run, id: 7, workflow_id: undefined, name: "lint" },
        { ...run, id: 8, workflow_id: undefined },
      ],
      [
        check,
        { ...check, id: 2, conclusion: "success" },
        { ...check, id: 3, app: { id: 9 } },
        { ...check, id: 4, head_sha: "old" },
        { ...check, id: 5, name: "lint", status: "queued" },
        { ...check, id: 6, name: "external", app: undefined },
      ],
      SHA
    )
  ).toMatchObject({ workflows: [{ id: 8 }, { id: 7 }, { id: 5 }], checks: [{ id: 6 }, { id: 3 }] })
})

it("counts only conclusions that mean the run failed", () => {
  for (const value of ["failure", "timed_out", "action_required", "startup_failure"])
    expect(failedConclusion(value)).toBe(true)
  for (const value of ["success", "neutral", "skipped", "cancelled", "stale", null])
    expect(failedConclusion(value)).toBe(false)
})
