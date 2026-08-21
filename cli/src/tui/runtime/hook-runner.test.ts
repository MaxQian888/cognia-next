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
  function harness(
    configHooks: Record<string, unknown>,
    exitCode = 0,
    opts: { sdkNativeHooks?: boolean } = {}
  ) {
    const spawned: string[] = []
    const spawn = ((cmd: string) => {
      spawned.push(cmd)
      return fakeChild(exitCode)
    }) as never
    const readFile = (p: string): string | null =>
      p.endsWith("config.json") ? settings(configHooks) : null
    // Disable the default-on built-in hooks so these tests isolate user config.
    //
    // `sdkNativeHooks: false` keeps this runner active. In production the CLI
    // injects the same config into `sendOptions.hooks` so the sidecar runs it
    // SDK-natively, and this runner stands down (see the dedicated describe
    // block below). These cases pin the fallback path that still serves a rail
    // which cannot inject.
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile,
      sdkNativeHooks: opts.sdkNativeHooks ?? false,
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
    // `sdkNativeHooks: false` because in production these built-ins are
    // INJECTED instead: `auto-context-loader` ships enabled and emits
    // `additionalContext`, which this runner never parses — the exact reason
    // the CLI now hands its config to the sidecar.
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile: () => null,
      sdkNativeHooks: false,
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
    // Without the flag this would pass for the wrong reason: the runner would
    // stand down anyway. Keep it active so the assertion really tests the
    // override.
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile: () => null,
      sdkNativeHooks: false,
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

  it("fires SessionStart and SessionEnd", async () => {
    const start = harness({ SessionStart: [{ hooks: [{ type: "command", command: "start.sh" }] }] })
    start.runner.onSessionStart("ses-1")
    await Promise.resolve()
    await Promise.resolve()
    expect(start.spawned).toContain("start.sh")

    const end = harness({ SessionEnd: [{ hooks: [{ type: "command", command: "end.sh" }] }] })
    end.runner.onSessionEnd("ses-1")
    await Promise.resolve()
    await Promise.resolve()
    expect(end.spawned).toContain("end.sh")
  })

  it("fires PermissionRequest AND Notification on a permission request", async () => {
    const { spawned, runner } = harness({
      PermissionRequest: [{ hooks: [{ type: "command", command: "perm.sh" }] }],
      Notification: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
    })
    runner.onPermissionRequest("Bash", { command: "ls" })
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toContain("perm.sh")
    expect(spawned).toContain("notify.sh")
  })

  it("fires PermissionDenied on a denial", async () => {
    const { spawned, runner } = harness({
      PermissionDenied: [{ hooks: [{ type: "command", command: "denied.sh" }] }],
    })
    runner.onPermissionDenied("Bash", "user rejected")
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toContain("denied.sh")
  })
})

describe("createHookRunner — standing down for SDK-native hooks", () => {
  function harness(configHooks: Record<string, unknown>, deps: { sdkNativeHooks?: boolean } = {}) {
    const spawned: string[] = []
    const spawn = ((cmd: string) => {
      spawned.push(cmd)
      return fakeChild(0)
    }) as never
    const readFile = (p: string): string | null =>
      p.endsWith("config.json") ? settings(configHooks) : null
    const runner = createHookRunner({
      home: "/home/.cognia",
      osHome: "/home",
      spawn,
      readFile,
      builtinHookOverrides: {
        "auto-context-loader": false,
        "auto-context-loader-prompt": false,
      },
      ...deps,
    })
    return { spawned, runner }
  }

  const userHooks = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt.sh" }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: "pre.sh" }] }],
  }

  it("defaults to standing down when there is a group to inject", async () => {
    // The CLI injects exactly when a group exists, so the presence of one means
    // the sidecar already owns the event — firing here would double-run it.
    const { spawned, runner } = harness(userHooks)
    runner.onPrompt("hello")
    runner.onSessionStart("s1")
    runner.onStop(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toEqual([])
  })

  it("stands down for the blocking PreToolUse path too", async () => {
    const { spawned, runner } = harness(userHooks)
    // The sidecar's SDK-native PreToolUse denies before `canUseTool`; a second
    // deny here would double-prompt the user.
    await expect(runner.preToolUse("Bash", {})).resolves.toEqual({ deny: false })
    expect(spawned).toEqual([])
  })

  it("still runs when there is nothing to inject and the flag is off", async () => {
    const { spawned, runner } = harness(userHooks, { sdkNativeHooks: false })
    runner.onPrompt("hello")
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toContain("prompt.sh")
  })

  it("an empty config is inert either way", async () => {
    const { spawned, runner } = harness({})
    runner.onPrompt("hello")
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toEqual([])
  })
})
