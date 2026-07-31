import { toToolActivityEntries } from "./subagent-tool-parts"
import type { SubAgentToolCall } from "@/types/agent/sub-agent"

describe("toToolActivityEntries", () => {
  it("returns an empty array for empty / undefined input", () => {
    expect(toToolActivityEntries(undefined)).toEqual([])
    expect(toToolActivityEntries([])).toEqual([])
  })

  it("maps a running call to input-available", () => {
    const calls: SubAgentToolCall[] = [
      { id: "c1", name: "read", state: "running", input: { p: 1 } },
    ]
    const [entry] = toToolActivityEntries(calls)
    expect(entry.key).toBe("c1")
    expect(entry.part.type).toBe("tool-read")
    expect(entry.part.state).toBe("input-available")
    expect(entry.part.input).toEqual({ p: 1 })
  })

  it("maps a done call to output-available with output", () => {
    const calls: SubAgentToolCall[] = [
      { id: "c2", name: "grep", state: "done", output: "5 matches" },
    ]
    const [entry] = toToolActivityEntries(calls)
    expect(entry.part.state).toBe("output-available")
    expect(entry.part.output).toBe("5 matches")
  })

  it("maps an error call to output-error with errorText", () => {
    const calls: SubAgentToolCall[] = [
      { id: "c3", name: "bash", state: "error", isError: true, output: { msg: "boom" } },
    ]
    const [entry] = toToolActivityEntries(calls)
    expect(entry.part.state).toBe("output-error")
    expect(entry.part.errorText).toBe(JSON.stringify({ msg: "boom" }))
  })

  it("defaults input to an empty object when absent", () => {
    const [entry] = toToolActivityEntries([{ id: "c4", name: "ls", state: "running" }])
    expect(entry.part.input).toEqual({})
  })
})
