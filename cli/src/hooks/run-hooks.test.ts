/** @jest-environment node */
import { EventEmitter } from "node:events"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { agentsMatch, matcherMatches, matchGroups, runHooks, type Spawn } from "./run-hooks"
import type { HookGroup } from "./types"

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

/** A child that never closes (for the timeout path). */
function hangingChild() {
  const ee = new EventEmitter() as EventEmitter & { stdin: { end: () => void } }
  ee.stdin = { end: () => {} }
  return ee
}

describe("matchGroups", () => {
  const cmd = { type: "command", command: "x" } as const

  it("a null-matcher group matches all (with or without a tool)", () => {
    const groups: HookGroup[] = [{ hooks: [cmd] }]
    expect(matchGroups(groups, "Bash")).toHaveLength(1)
    expect(matchGroups(groups, undefined)).toHaveLength(1)
  })

  it("an empty-string matcher matches all", () => {
    expect(matchGroups([{ matcher: "", hooks: [cmd] }], "Bash")).toHaveLength(1)
  })

  it("a comma-separated literal list matches exact tool names", () => {
    const groups: HookGroup[] = [{ matcher: "Bash, Write", hooks: [cmd] }]
    expect(matchGroups(groups, "Write")).toHaveLength(1)
    expect(matchGroups(groups, "Read")).toHaveLength(0)
  })

  it("a regex matcher matches matching tool names", () => {
    const groups: HookGroup[] = [{ matcher: "Edit|MultiEdit", hooks: [cmd] }]
    expect(matchGroups(groups, "MultiEdit")).toHaveLength(1)
    expect(matchGroups(groups, "Bash")).toHaveLength(0)
  })

  it("a matcher group does not apply to a non-tool event (no toolName)", () => {
    expect(matchGroups([{ matcher: "Bash", hooks: [cmd] }], undefined)).toHaveLength(0)
  })

  it("an invalid regex with no literal match does not match", () => {
    expect(matchGroups([{ matcher: "(", hooks: [cmd] }], "Bash")).toHaveLength(0)
  })
})

describe("runHooks", () => {
  it("denies on a non-zero PreToolUse command exit (first wins)", async () => {
    const spawn = (() => fakeChild(2)) as unknown as Spawn
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: { tool_input: { cmd: "rm -rf /" } },
      groups: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
      spawn,
    })
    expect(res.deny).toBe(true)
    expect(res.reason).toContain("exited 2")
  })

  it("denies on a non-zero UserPromptSubmit exit", async () => {
    const spawn = (() => fakeChild(1)) as unknown as Spawn
    const res = await runHooks({
      event: "UserPromptSubmit",
      payload: { prompt: "hi" },
      groups: [{ hooks: [{ type: "command", command: "guard" }] }],
      spawn,
    })
    expect(res.deny).toBe(true)
  })

  it("does not deny a non-blocking event even on non-zero exit", async () => {
    const spawn = (() => fakeChild(3)) as unknown as Spawn
    const res = await runHooks({
      event: "PostToolUse",
      toolName: "Bash",
      payload: {},
      groups: [{ hooks: [{ type: "command", command: "notify" }] }],
      spawn,
    })
    expect(res.deny).toBe(false)
  })

  it("allows when the command exits zero", async () => {
    const spawn = (() => fakeChild(0)) as unknown as Spawn
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: {},
      groups: [{ hooks: [{ type: "command", command: "ok" }] }],
      spawn,
    })
    expect(res.deny).toBe(false)
  })

  it("pipes the JSON payload (incl. event name + tool) on stdin", async () => {
    let written = ""
    const spawn = (() => {
      const child = fakeChild(0)
      const orig = child.stdin.end
      child.stdin.end = (t: string) => {
        written = t
        orig(t)
      }
      return child
    }) as unknown as Spawn
    await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: { tool_input: { cmd: "ls" } },
      groups: [{ hooks: [{ type: "command", command: "guard" }] }],
      spawn,
    })
    const parsed = JSON.parse(written)
    expect(parsed.hook_event_name).toBe("PreToolUse")
    expect(parsed.tool_name).toBe("Bash")
    expect(parsed.tool_input).toEqual({ cmd: "ls" })
  })

  it("ignores webhook and unknown handlers (inert)", async () => {
    const spawn = jest.fn() as unknown as Spawn
    const groups: HookGroup[] = [
      {
        hooks: [
          { type: "webhook", url: "https://x.test" },
          { type: "mcp_tool", server: "gh" } as unknown as HookGroup["hooks"][number],
        ],
      },
    ]
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: {},
      groups,
      spawn,
    })
    expect(res.deny).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("only runs handlers in matched groups", async () => {
    const calls: string[] = []
    const spawn = ((cmd: string) => {
      calls.push(cmd)
      return fakeChild(0)
    }) as unknown as Spawn
    await runHooks({
      event: "PreToolUse",
      toolName: "Read",
      payload: {},
      groups: [
        { matcher: "Bash", hooks: [{ type: "command", command: "bash-only" }] },
        { hooks: [{ type: "command", command: "all" }] },
      ],
      spawn,
    })
    expect(calls).toEqual(["all"])
  })

  it("short-circuits remaining handlers after the first deny", async () => {
    const calls: string[] = []
    const spawn = ((cmd: string) => {
      calls.push(cmd)
      return fakeChild(cmd === "first" ? 1 : 0)
    }) as unknown as Spawn
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: {},
      groups: [
        {
          hooks: [
            { type: "command", command: "first" },
            { type: "command", command: "second" },
          ],
        },
      ],
      spawn,
    })
    expect(res.deny).toBe(true)
    expect(calls).toEqual(["first"])
  })

  it("soft-allows (no deny) when the command times out", async () => {
    const spawn = (() => hangingChild()) as unknown as Spawn
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: {},
      groups: [{ hooks: [{ type: "command", command: "slow", timeout: 0.01 }] }],
      spawn,
      timeoutMsDefault: 5,
    })
    expect(res.deny).toBe(false)
  })

  it("soft-allows on a spawn error event", async () => {
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin: { end: () => void } }
      ee.stdin = { end: () => {} }
      queueMicrotask(() => ee.emit("error", new Error("ENOENT")))
      return ee
    }) as unknown as Spawn
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: {},
      groups: [{ hooks: [{ type: "command", command: "missing" }] }],
      spawn,
    })
    expect(res.deny).toBe(false)
  })

  it("soft-allows when spawn throws synchronously", async () => {
    const spawn = (() => {
      throw new Error("boom")
    }) as unknown as Spawn
    const res = await runHooks({
      event: "PreToolUse",
      toolName: "Bash",
      payload: {},
      groups: [{ hooks: [{ type: "command", command: "x" }] }],
      spawn,
    })
    expect(res.deny).toBe(false)
  })
})

// --- Cross-rail matcher conformance ----------------------------------------

describe("matcher conformance", () => {
  // Same table the sidecar and Rust suites read. This rail used to split on
  // commas only and then anchor the regex fallback, so an author's
  // `"^Notebook"` matched on the desktop and silently matched nothing here.
  const table = JSON.parse(
    readFileSync(join(__dirname, "../../../hooks/matcher-conformance.json"), "utf8")
  ) as {
    cases: { matcher: string | null; target: string; expected: boolean; why: string }[]
    narrowCases: { matcher: string | null; target: string; expected: boolean; why: string }[]
  }

  it.each(table.cases)("wide: $matcher vs $target → $expected ($why)", (c) => {
    // An absent matcher is handled by matchGroups, not matcherMatches.
    if (c.matcher == null) {
      expect(matchGroups([{ hooks: [] }], c.target)).toHaveLength(1)
      return
    }
    expect(matcherMatches(c.matcher, c.target)).toBe(c.expected)
  })

  it.each(table.narrowCases)("narrow: $matcher vs $target → $expected ($why)", (c) => {
    if (c.matcher == null) {
      expect(matchGroups([{ hooks: [] }], c.target)).toHaveLength(1)
      return
    }
    expect(matcherMatches(c.matcher, c.target, true)).toBe(c.expected)
  })

  it("routes the narrow alphabet by event, not by caller", () => {
    const group: HookGroup = { matcher: "a,b", hooks: [] }
    // Tool events use the wide alphabet, so the comma separates alternatives.
    expect(matchGroups([group], "a", { event: "PostToolUse" })).toHaveLength(1)
    // FileChanged targets are paths — the comma stays regex-literal.
    expect(matchGroups([group], "a", { event: "FileChanged" })).toHaveLength(0)
  })
})

describe("agents selector", () => {
  const identity = { agentKind: "teammate", agentRef: "reviewer" }

  it("absent or star matches every agent, including unidentified turns", () => {
    expect(agentsMatch(undefined, identity)).toBe(true)
    expect(agentsMatch("*", identity)).toBe(true)
    expect(agentsMatch("", identity)).toBe(true)
    expect(agentsMatch(undefined, undefined)).toBe(true)
  })

  it("matches the kind or the ref, using matcher syntax", () => {
    expect(agentsMatch("teammate", identity)).toBe(true)
    expect(agentsMatch("reviewer", identity)).toBe(true)
    expect(agentsMatch("chat|teammate", identity)).toBe(true)
    expect(agentsMatch("chat", identity)).toBe(false)
  })

  it("a present selector never matches an unidentified turn", () => {
    expect(agentsMatch("teammate", undefined)).toBe(false)
    expect(agentsMatch("teammate", { agentKind: "" })).toBe(false)
  })

  it("narrows independently of the matcher, and on matcher-less events too", () => {
    const toolGroup: HookGroup = { matcher: "Bash", agents: "teammate", hooks: [] }
    expect(matchGroups([toolGroup], "Bash", { identity })).toHaveLength(1)
    expect(matchGroups([toolGroup], "Bash", { identity: { agentKind: "chat" } })).toHaveLength(0)
    expect(matchGroups([toolGroup], "Read", { identity })).toHaveLength(0)

    // UserPromptSubmit carries no tool name, so `matcher` cannot narrow it —
    // `agents` still must, or the selector would be inert on exactly the
    // events guards care about most.
    const promptGroup: HookGroup = { agents: "chat", hooks: [] }
    expect(matchGroups([promptGroup], undefined, { identity: { agentKind: "chat" } })).toHaveLength(
      1
    )
    expect(matchGroups([promptGroup], undefined, { identity })).toHaveLength(0)
  })

  it("forwards the identity to the hook script as payload fields", async () => {
    const children: { written?: string }[] = []
    const spawn = ((): unknown => {
      const child = fakeChild(0)
      children.push(child)
      return child
    }) as unknown as Spawn

    await runHooks({
      event: "PostToolUse",
      toolName: "Bash",
      payload: { tool_response: "ok" },
      groups: [{ hooks: [{ type: "command", command: "guard.mjs" }] }],
      spawn,
      identity,
    })

    expect(JSON.parse(children[0]!.written!)).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      agent_kind: "teammate",
      agent_ref: "reviewer",
    })
  })
})
