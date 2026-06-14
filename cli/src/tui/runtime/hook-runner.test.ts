import { EventEmitter } from "node:events"

import { createHookRunner } from "./hook-runner"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

/** A minimal fake child process: emits `close` with the given code next tick. */
function fakeChild(code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: (d?: unknown) => void; on: () => void }
  }
  child.stdin = { end: () => {}, on: () => {} }
  queueMicrotask(() => child.emit("close", code))
  return child as never
}

function settings(hooks: Record<string, unknown>): string {
  return JSON.stringify({ hooks })
}

describe("createHookRunner", () => {
  function harness(configHooks: Record<string, unknown>, exitCode = 0) {
    const spawned: string[] = []
    const spawn = ((cmd: string) => {
      spawned.push(cmd)
      return fakeChild(exitCode)
    }) as never
    const readFile = (p: string): string | null =>
      p.endsWith("config.json") ? settings(configHooks) : null
    // Disable the default-on built-in hooks so these tests isolate user config.
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile,
      builtinHookOverrides: {
        "auto-context-loader": false,
        "auto-context-loader-prompt": false,
      },
    })
    return { spawned, runner }
  }

  const toolResult: CaptureStreamEvent = {
    type: "tool-result",
    id: "t1",
    name: "Edit",
    input: { file_path: "/x" },
    result: "ok",
  } as unknown as CaptureStreamEvent

  it("fires PostToolUse command hooks on a tool-result capture event", async () => {
    const { spawned, runner } = harness({
      PostToolUse: [{ hooks: [{ type: "command", command: "post.sh" }] }],
    })
    runner.onCapture(toolResult)
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toContain("post.sh")
  })

  it("is a no-op when no hooks are configured for the event", async () => {
    const { spawned, runner } = harness({})
    runner.onCapture(toolResult)
    runner.onStop(true)
    runner.onPrompt("hi")
    await Promise.resolve()
    expect(spawned).toHaveLength(0)
  })

  it("merges default-on built-in hooks under user config", async () => {
    const spawned: string[] = []
    const spawn = ((cmd: string) => {
      spawned.push(cmd)
      return fakeChild(0)
    }) as never
    // No user hooks at all — only the bundled built-ins should fire.
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile: () => null,
      builtinHooksDir: "/bundle/hooks/builtin",
    })
    runner.onPrompt("hi")
    await Promise.resolve()
    expect(spawned.some((c) => c.includes("auto-context-loader.mjs"))).toBe(true)
  })

  it("honors a built-in override that disables a default-on hook", async () => {
    const spawned: string[] = []
    const spawn = ((cmd: string) => {
      spawned.push(cmd)
      return fakeChild(0)
    }) as never
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile: () => null,
      builtinHooksDir: "/bundle/hooks/builtin",
      builtinHookOverrides: { "auto-context-loader-prompt": false },
    })
    runner.onPrompt("hi")
    await Promise.resolve()
    expect(spawned).toHaveLength(0)
  })

  it("fires Stop on success and StopFailure on error", async () => {
    const stop = harness({ Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }] })
    stop.runner.onStop(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(stop.spawned).toContain("stop.sh")

    const fail = harness({ StopFailure: [{ hooks: [{ type: "command", command: "fail.sh" }] }] })
    fail.runner.onStop(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(fail.spawned).toContain("fail.sh")
  })

  it("fires UserPromptSubmit on a prompt", async () => {
    const { spawned, runner } = harness({
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt.sh" }] }],
    })
    runner.onPrompt("do a thing")
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toContain("prompt.sh")
  })

  it("denies a tool when a PreToolUse command exits non-zero", async () => {
    const { runner } = harness(
      { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "guard.sh" }] }] },
      2
    )
    const decision = await runner.preToolUse("Edit", { file_path: "/x" })
    expect(decision.deny).toBe(true)
  })

  it("allows a tool when no PreToolUse hooks are configured", async () => {
    const { runner } = harness({})
    expect(await runner.preToolUse("Edit", {})).toEqual({ deny: false })
  })
})
