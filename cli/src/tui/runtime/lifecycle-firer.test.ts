/** @jest-environment node */
import { EventEmitter } from "node:events"

import { createCliLifecycleFirer } from "./lifecycle-firer"
import type { AgentHookContext } from "@/lib/claude/hooks/lifecycle-firer"

/** A fake child process that records the piped stdin + a scripted close code. */
function fakeChild(code: number) {
  const ee = new EventEmitter() as EventEmitter & {
    stdin: { end: (t: string) => void }
    written?: string
  }
  ee.stdin = { end: (t: string) => (ee.written = t) }
  queueMicrotask(() => ee.emit("close", code))
  return ee
}

const ctx: AgentHookContext = {
  agentId: "goal-judge",
  agentKind: "goal-judge",
  sessionId: "s1",
}

/** A readFile that returns a cognia config.json with one UserPromptSubmit hook. */
function configWithUserPromptSubmit(command: string) {
  return (absPath: string): string | null => {
    if (absPath.endsWith("config.json")) {
      return JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
      })
    }
    return null
  }
}

describe("createCliLifecycleFirer", () => {
  it("returns null for an event with no configured groups", async () => {
    const firer = createCliLifecycleFirer({
      home: "/home/.cognia",
      osHome: "/home",
      readFile: () => null,
      spawn: (() => fakeChild(0)) as never,
    })
    expect(await firer("SessionStart", ctx)).toBeNull()
  })

  it("returns null for an unknown event name", async () => {
    const firer = createCliLifecycleFirer({
      home: "/home/.cognia",
      osHome: "/home",
      readFile: configWithUserPromptSubmit("guard"),
      spawn: (() => fakeChild(2)) as never,
    })
    expect(await firer("NotARealEvent", ctx)).toBeNull()
  })

  it("blocks when a UserPromptSubmit command exits non-zero", async () => {
    const firer = createCliLifecycleFirer({
      home: "/home/.cognia",
      osHome: "/home",
      readFile: configWithUserPromptSubmit("guard"),
      spawn: (() => fakeChild(2)) as never,
    })
    const decision = await firer("UserPromptSubmit", ctx, { payload: { prompt: "P" } })
    expect(decision?.block).toContain("exited 2")
    expect(decision?.additionalContext).toBeNull()
  })

  it("allows (block:null) when the command exits zero", async () => {
    const firer = createCliLifecycleFirer({
      home: "/home/.cognia",
      osHome: "/home",
      readFile: configWithUserPromptSubmit("guard"),
      spawn: (() => fakeChild(0)) as never,
    })
    const decision = await firer("UserPromptSubmit", ctx, { payload: { prompt: "P" } })
    expect(decision?.block).toBeNull()
  })
})
