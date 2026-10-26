import type { HarnessToolRule } from "@cognia/agent-config-types"
import type { ToolResultProjectValue } from "@/lib/plugin/interceptors/normalize"
import type { InterceptorRegistration } from "@/lib/plugin/interceptors/types"
import {
  LIVE_RULES_REGISTRATION_ID,
  UNKEYED_TURN_IDLE_MS,
  createLiveToolRulesHandler,
  createLiveToolRulesSwitch,
  excludeSessionFromLiveToolRules,
  isSessionExcludedFromLiveToolRules,
} from "./live-rules"

const rules: HarnessToolRule[] = [
  { id: "cap", kind: "call-cap", tool: "Bash", maxCalls: 1, reason: "Stop looping." },
  { id: "trim", kind: "trim-output", tool: "Read", maxChars: 200 },
  {
    id: "enoent",
    kind: "error-hint",
    tool: "*",
    patterns: ["ENOENT"],
    hint: "List the directory first.",
  },
  { id: "verify", kind: "verify-after-write", tool: "Write", reminder: "Re-open the file." },
]

function value(over: Partial<ToolResultProjectValue> = {}): ToolResultProjectValue {
  return {
    toolName: "Write",
    toolArgs: {},
    toolResult: "ok",
    sessionId: "sess-1",
    isError: false,
    turnId: "t1",
    projection: {},
    ...over,
  }
}

function setup() {
  let clock = 1_000
  const handler = createLiveToolRulesHandler({
    characterIdOfSession: async (id) =>
      id === "sess-1" ? "agent-1" : id === "plain" ? "agent-2" : undefined,
    rulesOfCharacter: async (id) => (id === "agent-1" ? rules : []),
    now: () => clock,
  })
  return { handler, advance: (ms: number) => (clock += ms) }
}

describe("createLiveToolRulesHandler", () => {
  it("applies the agent's adopted rules to its own conversations only", async () => {
    const { handler } = setup()
    const out = await handler(value())
    expect(out.projection.modifiedResult).toBe("ok\n\n[harness reminder verify] Re-open the file.")
    for (const sessionId of ["plain", "unknown"]) {
      const untouched = value({ sessionId })
      expect(await handler(untouched)).toBe(untouched)
    }
  })

  it("builds on an earlier interceptor's rewrite and leaves unknown outcomes alone", async () => {
    const { handler } = setup()
    const out = await handler(
      value({
        toolName: "Bash",
        isError: true,
        toolResult: "raw",
        projection: { modifiedResult: "ENOENT: x" },
      })
    )
    expect(out.projection.modifiedResult).toBe(
      "ENOENT: x\n\n[harness hint enoent] List the directory first."
    )
    const unknown = value({ isError: undefined })
    expect(await handler(unknown)).toBe(unknown)
  })

  it("counts call caps per turn", async () => {
    const { handler, advance } = setup()
    const bash = (turnId?: string) => value({ toolName: "Bash", toolResult: "done", turnId })
    expect((await handler(bash("t1"))).projection.modifiedResult).toBeUndefined()
    expect((await handler(bash("t1"))).projection.modifiedResult).toMatch(/Result withheld/)
    // A new turn starts over.
    expect((await handler(bash("t2"))).projection.modifiedResult).toBeUndefined()
    // Without turn ids, calls continue the current count until a long quiet.
    expect((await handler(bash(undefined))).projection.modifiedResult).toMatch(/Result withheld/)
    advance(UNKEYED_TURN_IDLE_MS + 1)
    expect((await handler(bash(undefined))).projection.modifiedResult).toBeUndefined()
    expect((await handler(bash(undefined))).projection.modifiedResult).toMatch(/Result withheld/)
    advance(UNKEYED_TURN_IDLE_MS + 1)
    expect((await handler(bash(undefined))).projection.modifiedResult).toBeUndefined()
  })

  it("skips excluded conversations until the exclusion is undone", async () => {
    const { handler } = setup()
    const undo = excludeSessionFromLiveToolRules("sess-1")
    expect(isSessionExcludedFromLiveToolRules("sess-1")).toBe(true)
    const v = value()
    expect(await handler(v)).toBe(v)
    undo()
    expect((await handler(value())).projection.modifiedResult).toBeDefined()
  })
})

describe("createLiveToolRulesSwitch", () => {
  it("registers only while some agent has rules", () => {
    const registered: InterceptorRegistration[] = []
    let unregistered = 0
    const live = createLiveToolRulesSwitch(
      {
        characterIdOfSession: async () => undefined,
        rulesOfCharacter: async () => [],
        now: () => 0,
      },
      {
        register: (r) => {
          registered.push(r)
          return () => {
            unregistered += 1
          }
        },
      }
    )
    live.update(false)
    expect(registered).toHaveLength(0)
    live.update(true)
    live.update(true)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      registrationId: LIVE_RULES_REGISTRATION_ID,
      pointId: "tool.result.project",
      semantic: "transform",
      trustTier: "builtin",
    })
    live.update(false)
    expect(unregistered).toBe(1)
    live.update(true)
    live.dispose()
    expect(unregistered).toBe(2)
  })
})
