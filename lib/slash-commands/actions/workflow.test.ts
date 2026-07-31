/**
 * @jest-environment jsdom
 */
import {
  WORKFLOW_COPILOT_DISPATCH_EVENT,
  WORKFLOW_SLASH_COMMANDS,
  buildWorkflowSlashPrompt,
  dispatchWorkflowSlashAction,
  parseDelegateArgs,
} from "./workflow"
import type { SlashContext } from "../builtin"

function makeCtx(p: Partial<SlashContext> = {}): SlashContext {
  return {
    args: "",
    activeSessionId: "workflow:wf_42",
    chatStatus: "ready" as never,
    currentPermissionMode: null,
    startNewSession: () => undefined,
    openSettings: () => undefined,
    setPermissionMode: () => undefined,
    pushSystemMessage: () => undefined,
    ...p,
  } as SlashContext
}

describe("dispatchWorkflowSlashAction", () => {
  it("emits a CustomEvent with the action payload on the window", () => {
    const detail: Array<unknown> = []
    const listener = (e: Event): void => {
      detail.push((e as CustomEvent).detail)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      const ok = dispatchWorkflowSlashAction({ kind: "validate" })
      expect(ok).toBe(true)
      expect(detail).toHaveLength(1)
      expect(detail[0]).toEqual({ action: { kind: "validate" } })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })
})

describe("WORKFLOW_SLASH_COMMANDS — gating", () => {
  const cmdByName: Record<string, (typeof WORKFLOW_SLASH_COMMANDS)[number]> = Object.fromEntries(
    WORKFLOW_SLASH_COMMANDS.map((c) => [c.name, c])
  )

  it("ships exactly seven core commands (six core + /delegate)", () => {
    expect(WORKFLOW_SLASH_COMMANDS.map((c) => c.name).sort()).toEqual([
      "debug",
      "delegate",
      "explain",
      "refactor",
      "run",
      "suggest",
      "validate",
    ])
  })

  it("refuses to dispatch when not in a workflow-editor session", async () => {
    const events: Event[] = []
    const listener = (e: Event): void => {
      events.push(e)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      const pushes: string[] = []
      const ctx = makeCtx({
        activeSessionId: "s_main",
        pushSystemMessage: (m) => {
          if (typeof m === "string") pushes.push(m)
        },
      })
      await cmdByName.validate.handler!(ctx)
      expect(events).toHaveLength(0)
      expect(pushes.join("\n")).toMatch(/only available inside the workflow editor/)
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("dispatches when the session id starts with 'workflow:'", async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      await cmdByName.validate.handler!(makeCtx())
      expect(events).toHaveLength(1)
      expect(events[0].detail).toEqual({ action: { kind: "validate" } })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("/run forwards an optional stepId from ctx.args", async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      await cmdByName.run.handler!(makeCtx({ args: "  n_step_42 " }))
      expect(events[0].detail).toEqual({ action: { kind: "run", stepId: "n_step_42" } })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("/run with empty args omits the stepId", async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      await cmdByName.run.handler!(makeCtx({ args: "" }))
      expect(events[0].detail).toEqual({ action: { kind: "run" } })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("/refactor requires a non-empty description", async () => {
    const events: CustomEvent[] = []
    const pushes: string[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      await cmdByName.refactor.handler!(
        makeCtx({
          args: "  ",
          pushSystemMessage: (m) => {
            if (typeof m === "string") pushes.push(m)
          },
        })
      )
      expect(events).toHaveLength(0)
      expect(pushes.join("\n")).toMatch(/Usage/)
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("/refactor with a description dispatches the action", async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      await cmdByName.refactor.handler!(makeCtx({ args: "wrap the AI step in retry + fallback" }))
      expect(events[0].detail).toEqual({
        action: { kind: "refactor", description: "wrap the AI step in retry + fallback" },
      })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("/explain carries args verbatim (for @-mention chains)", async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      await cmdByName.explain.handler!(makeCtx({ args: "@node:n_extract @node:n_open_pr" }))
      expect(events[0].detail).toEqual({
        action: { kind: "explain", args: "@node:n_extract @node:n_open_pr" },
      })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("every command is marked category: 'workflow'", () => {
    for (const cmd of WORKFLOW_SLASH_COMMANDS) {
      expect(cmd.category).toBe("workflow")
    }
  })
})

describe("buildWorkflowSlashPrompt", () => {
  it("returns null for validate / explain / suggest (those use the quick-action builders)", () => {
    expect(buildWorkflowSlashPrompt({ kind: "validate" })).toBeNull()
    expect(buildWorkflowSlashPrompt({ kind: "suggest" })).toBeNull()
    expect(buildWorkflowSlashPrompt({ kind: "explain", args: "" })).toBeNull()
  })

  it("/run without stepId asks for a full-workflow run", () => {
    const prompt = buildWorkflowSlashPrompt({ kind: "run" })
    expect(prompt).toMatch(/\/run/)
    expect(prompt).toMatch(/wf_run_workflow/)
    expect(prompt).toMatch(/wf_get_validation_errors/)
  })

  it("/run with a stepId asks for wf_run_from_step", () => {
    const prompt = buildWorkflowSlashPrompt({ kind: "run", stepId: "n_step_3" })!
    expect(prompt).toMatch(/n_step_3/)
    expect(prompt).toMatch(/wf_run_from_step/)
  })

  it("/debug references the workflow-debugger subagent", () => {
    const prompt = buildWorkflowSlashPrompt({ kind: "debug" })!
    expect(prompt).toMatch(/workflow-debugger/)
    expect(prompt).toMatch(/Do NOT mutate/)
  })

  it("/refactor references the workflow-refactorer subagent and embeds the description", () => {
    const prompt = buildWorkflowSlashPrompt({
      kind: "refactor",
      description: "wrap in retry + fallback",
    })!
    expect(prompt).toMatch(/workflow-refactorer/)
    expect(prompt).toMatch(/wrap in retry \+ fallback/)
    expect(prompt).toMatch(/wf_propose_batch/)
  })

  it("/delegate emits a Task-tool-driven handoff prompt with the resolved subagent name", () => {
    const prompt = buildWorkflowSlashPrompt({
      kind: "delegate",
      alias: "debugger",
      task: "why is the cron node not firing",
    })!
    expect(prompt).toMatch(/workflow-debugger/)
    expect(prompt).toMatch(/Task/)
    expect(prompt).toMatch(/why is the cron node not firing/)
  })
})

describe("parseDelegateArgs", () => {
  it("accepts a valid alias + task", () => {
    expect(parseDelegateArgs("debugger explain the failing http call")).toEqual({
      ok: true,
      alias: "debugger",
      task: "explain the failing http call",
    })
  })

  it("normalises the alias case", () => {
    expect(parseDelegateArgs("DESIGNER add a Telegram trigger")).toEqual({
      ok: true,
      alias: "designer",
      task: "add a Telegram trigger",
    })
  })

  it("rejects an unknown alias", () => {
    const out = parseDelegateArgs("auditor look at the cron")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toMatch(/Unknown subagent alias/)
  })

  it("rejects an empty input", () => {
    const out = parseDelegateArgs("")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toMatch(/Usage/)
  })

  it("rejects an alias without a task", () => {
    const out = parseDelegateArgs("doc-writer")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toMatch(/task description/i)
  })
})

describe("/delegate slash command handler", () => {
  const delegate = WORKFLOW_SLASH_COMMANDS.find((c) => c.name === "delegate")!

  it("emits a delegate action when the args parse cleanly", async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      const ctx = {
        args: "refactorer parallelize the two analyses",
        activeSessionId: "workflow:wf_42",
        chatStatus: "ready",
        currentPermissionMode: null,
        startNewSession: () => undefined,
        openSettings: () => undefined,
        setPermissionMode: () => undefined,
        pushSystemMessage: () => undefined,
      } as unknown as SlashContext
      await delegate.handler!(ctx)
      expect(events).toHaveLength(1)
      expect(events[0].detail).toEqual({
        action: {
          kind: "delegate",
          alias: "refactorer",
          task: "parallelize the two analyses",
        },
      })
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })

  it("reports usage on an unknown alias without dispatching", async () => {
    const events: CustomEvent[] = []
    const pushes: string[] = []
    const listener = (e: Event): void => {
      events.push(e as CustomEvent)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    try {
      const ctx = {
        args: "intruder do bad things",
        activeSessionId: "workflow:wf_42",
        chatStatus: "ready",
        currentPermissionMode: null,
        startNewSession: () => undefined,
        openSettings: () => undefined,
        setPermissionMode: () => undefined,
        pushSystemMessage: (m: string) => pushes.push(m),
      } as unknown as SlashContext
      await delegate.handler!(ctx)
      expect(events).toHaveLength(0)
      expect(pushes.join("\n")).toMatch(/Unknown subagent alias/)
    } finally {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, listener)
    }
  })
})
