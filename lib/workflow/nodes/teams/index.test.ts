import "."
import { getExecutor } from "../registry"

describe("team-nodes registration", () => {
  it.each([
    ["action.agent.turn", 1],
    ["action.character.create", 1],
    ["action.character.send", 1],
    ["action.character.update", 1],
    ["action.team.compose", 1],
    ["action.team.create", 1],
    ["action.team.delegate", 1],
    ["action.team.message", 1],
    ["action.team.reconcile", 1],
    ["action.team.run", 1],
    ["action.team.status", 1],
    ["action.team.task.dispatch", 1],
    ["action.team.task.review", 1],
    ["action.team.update", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
