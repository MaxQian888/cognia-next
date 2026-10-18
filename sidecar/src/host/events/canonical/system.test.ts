import test from "node:test"
import assert from "node:assert/strict"
import { fromSystem } from "./system.ts"

test("unknown and prototype-named subtypes remain diagnostics", () => {
  for (const subtype of ["__proto__", "toString", "constructor", "future"]) {
    const event = { type: "system", subtype }
    assert.deepEqual(fromSystem(event), [
      { kind: "diagnostic", runtime: "claude-agent-sdk", payload: event },
    ])
  }
})

test("task projections retain parentage and distinguish resumed runs", () => {
  assert.deepEqual(
    fromSystem({
      subtype: "task_started",
      task_id: "child",
      parent_task_id: "parent",
      run_id: "run-2",
    }),
    [{ kind: "task", phase: "started", taskId: "child", parentTaskId: "parent", runId: "run-2" }]
  )
  assert.deepEqual(
    fromSystem({
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "child",
          task_type: "local_agent",
          description: "work",
          parent_task_id: "parent",
          run_id: "run-2",
          subagent_type: "researcher",
          ambient: true,
        },
      ],
    }),
    [
      {
        kind: "task-inventory",
        tasks: [
          {
            taskId: "child",
            taskType: "local_agent",
            description: "work",
            parentTaskId: "parent",
            runId: "run-2",
            subagentType: "researcher",
            ambient: true,
          },
        ],
      },
    ]
  )
})
