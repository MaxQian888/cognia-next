import { anyTerminalRunning, wireTerminalSource } from "./terminal-source"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { PetEvent } from "@/types/pet"

function session(status: string) {
  return { status } as never
}

beforeEach(() => {
  useTerminalStore.setState({ sessions: {} })
})

describe("anyTerminalRunning", () => {
  it("is true when any session is running", () => {
    useTerminalStore.setState({ sessions: { a: session("idle"), b: session("running") } })
    expect(anyTerminalRunning()).toBe(true)
    useTerminalStore.setState({ sessions: { a: session("idle"), b: session("exited") } })
    expect(anyTerminalRunning()).toBe(false)
  })
})

describe("wireTerminalSource", () => {
  it("emits thinking when a command starts and success when all finish", () => {
    const events: PetEvent[] = []
    const off = wireTerminalSource((e) => events.push({ ...e, at: 0 }))
    useTerminalStore.setState({ sessions: { a: session("running") } })
    useTerminalStore.setState({ sessions: { a: session("exited") } })
    off()
    expect(events.map((e) => e.kind)).toEqual(["thinking", "success"])
    expect(events[1]).toMatchObject({ source: "terminal", xp: 1 })
  })
})
