import "./flow"
import { getExecutor } from "../registry"

describe("flow-data-nodes registration", () => {
  it.each([
    ["data.aggregate", 1],
    ["data.code", 1],
    ["data.template", 1],
    ["data.transform", 1],
    ["flow.branch", 1],
    ["flow.branch", 2],
    ["flow.break", 1],
    ["flow.catch", 1],
    ["flow.continue", 1],
    ["flow.join", 1],
    ["flow.loop", 1],
    ["flow.set", 1],
    ["flow.split", 1],
    ["flow.subworkflow", 1],
    ["flow.switch", 1],
    ["flow.switch", 2],
    ["flow.wait", 1],
    ["io.http", 1],
    ["io.output", 1],
    ["io.answer", 1],
    ["io.webhook.respond", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
