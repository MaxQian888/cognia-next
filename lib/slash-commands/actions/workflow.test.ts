/**
 * @jest-environment jsdom
 */
import {
  WORKFLOW_COPILOT_DISPATCH_EVENT,
  WORKFLOW_SLASH_COMMANDS,
  buildWorkflowSlashPrompt,
  dispatchWorkflowSlashAction,
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

  it("ships exactly the six core commands", () => {
    expect(WORKFLOW_SLASH_COMMANDS.map((c) => c.name).sort()).toEqual([
      "debug",
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
          pushes.push(m)
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
            pushes.push(m)
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
})
