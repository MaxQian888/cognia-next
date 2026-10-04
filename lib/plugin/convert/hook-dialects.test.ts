import {
  HOOK_DIALECTS,
  canonicalHooksToDialect,
  hookDocumentToCanonical,
  type HookIssueSink,
} from "./hook-dialects"
import type { HooksConfig } from "@/lib/claude/hooks"
import { HOOK_EVENTS } from "@/lib/claude/hooks/event-catalog"

const sink = (): HookIssueSink => ({ warnings: [], blocking: [] })

describe("hook dialects", () => {
  it("only maps host events onto canonical Cognia events", () => {
    for (const dialect of Object.values(HOOK_DIALECTS)) {
      for (const event of Object.values(dialect.events))
        expect(HOOK_EVENTS as readonly string[]).toContain(event)
    }
    expect(Object.keys(HOOK_DIALECTS["claude-code"].events)).toHaveLength(HOOK_EVENTS.length)
  })

  it("passes Claude documents through untouched", () => {
    const value = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo" }] }] } }
    const issues = sink()
    expect(
      hookDocumentToCanonical({
        value,
        path: "hooks.json",
        dialect: HOOK_DIALECTS["claude-code"],
        sink: issues,
      })
    ).toBe(value)
    expect(issues).toEqual({ warnings: [], blocking: [] })
  })

  it("renames Gemini events, converts millisecond timeouts and drops presentation labels", () => {
    const issues = sink()
    const result = hookDocumentToCanonical({
      value: {
        hooks: {
          BeforeTool: [
            {
              matcher: "*",
              sequential: false,
              hooks: [{ type: "command", command: "guard.sh", timeout: 1500, name: "Guard" }],
            },
          ],
          PreCompress: [{ hooks: [{ type: "command", command: "save.sh" }] }],
        },
      },
      path: "hooks/hooks.json",
      dialect: HOOK_DIALECTS["gemini-cli"],
      sink: issues,
    })
    expect(result).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "guard.sh", timeout: 1.5 }] }],
        PreCompact: [{ hooks: [{ type: "command", command: "save.sh" }] }],
      },
    })
    expect(issues.blocking).toEqual([])
    expect(issues.warnings.map((issue) => issue.message).join("\n")).toMatch(/labels the hook/)
    expect(issues.warnings.map((issue) => issue.message).join("\n")).toMatch(/differ from Claude/)
  })

  it.each([
    [{ BeforeModel: [{ hooks: [{ type: "command", command: "x" }] }] }, /no exact Cognia/],
    [
      {
        BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "x" }] }],
      },
      /vocabulary/,
    ],
    [
      { BeforeTool: [{ sequential: true, hooks: [{ type: "command", command: "x" }] }] },
      /sequential/,
    ],
    [{ AfterTool: [{ hooks: [{ type: "http", url: "https://x.test" }] }] }, /not executed/],
    [{ AfterTool: {} }, /must map to an array/],
    [{ AfterTool: [null] }, /must be an object/],
  ])("blocks Gemini hooks without an exact mapping %#", (hooks, message) => {
    const issues = sink()
    hookDocumentToCanonical({
      value: { hooks },
      path: "hooks/hooks.json",
      dialect: HOOK_DIALECTS["gemini-cli"],
      sink: issues,
    })
    expect(issues.blocking.map((issue) => issue.message).join("\n")).toMatch(message)
  })

  it("turns Cursor's flat entries into Claude groups and rejects unknown file fields", () => {
    const issues = sink()
    const result = hookDocumentToCanonical({
      value: {
        version: 1,
        hooks: {
          beforeSubmitPrompt: [{ command: "./check.sh", timeout: 5 }],
          stop: [{ command: "./done.sh", matcher: "*" }],
        },
      },
      path: "hooks/hooks.json",
      dialect: HOOK_DIALECTS.cursor,
      sink: issues,
    })
    expect(result).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ command: "./check.sh", timeout: 5, type: "command" }] }],
        Stop: [{ hooks: [{ command: "./done.sh", type: "command" }] }],
      },
    })
    expect(issues.blocking).toEqual([])
    const unknown = sink()
    hookDocumentToCanonical({
      value: { version: 2, hooks: { afterFileEdit: [{ command: "x" }] } },
      path: "hooks/hooks.json",
      dialect: HOOK_DIALECTS.cursor,
      sink: unknown,
    })
    expect(unknown.blocking.map((issue) => issue.message).join("\n")).toMatch(/version/)
    expect(unknown.blocking.map((issue) => issue.message).join("\n")).toMatch(/afterFileEdit/)
  })

  it("restricts CodeBuddy prompt hooks to their documented events", () => {
    const issues = sink()
    hookDocumentToCanonical({
      value: { hooks: { SessionStart: [{ hooks: [{ type: "prompt", prompt: "Check" }] }] } },
      path: "hooks/hooks.json",
      dialect: HOOK_DIALECTS.codebuddy,
      sink: issues,
    })
    expect(issues.blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("only runs prompt hooks") }),
      ])
    )
  })

  it("projects canonical hooks per dialect and reports every omission", () => {
    const hooks: HooksConfig = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "guard.sh", timeout: 2 }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }],
      TaskCreated: [{ hooks: [{ type: "command", command: "task.sh" }] }],
    }
    const codex = sink()
    expect(
      canonicalHooksToDialect({
        hooks,
        dialect: HOOK_DIALECTS.codex,
        sink: codex,
        path: "hooks/hooks.json",
      })
    ).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "guard.sh", timeout: 2 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }],
      },
    })
    expect(codex.blocking.map((issue) => issue.message)).toEqual([
      "Codex has no hook event equivalent to TaskCreated",
    ])

    const gemini = sink()
    const projected = canonicalHooksToDialect({
      hooks: {
        Stop: hooks.Stop,
        PreToolUse: [{ hooks: [{ type: "command", command: "g.sh", timeout: 2 }] }],
      },
      dialect: HOOK_DIALECTS["gemini-cli"],
      sink: gemini,
      path: "hooks/hooks.json",
    })
    expect(projected).toEqual({
      hooks: { BeforeTool: [{ hooks: [{ type: "command", command: "g.sh", timeout: 2000 }] }] },
    })
    expect(gemini.blocking.map((issue) => issue.message)).toEqual([
      "Gemini CLI has no hook event equivalent to Stop",
    ])

    const cursor = sink()
    expect(
      canonicalHooksToDialect({
        hooks: { Stop: hooks.Stop, PreToolUse: hooks.PreToolUse },
        dialect: HOOK_DIALECTS.cursor,
        sink: cursor,
        path: "hooks/hooks.json",
      })
    ).toEqual({ version: 1, hooks: { stop: [{ command: "done.sh" }] } })
    expect(cursor.blocking.map((issue) => issue.message).join("\n")).toMatch(/tool vocabulary/)
  })

  it("blocks agent selectors, managed policies, unsupported handlers and inline Auggie commands", () => {
    const issues = sink()
    const result = canonicalHooksToDialect({
      hooks: {
        Stop: [
          { agents: "teammate", hooks: [{ type: "command", command: "a.sh" }] },
          { hooks: [{ type: "command", command: "echo inline" }] },
          { hooks: [{ type: "command", command: "./ok.sh --flag", policyClass: "managed" }] },
          { hooks: [{ type: "http", url: "https://x.test" }] },
          { hooks: [{ type: "command", command: "./ok.sh --flag", timeout: 3 }] },
        ],
      },
      dialect: HOOK_DIALECTS.auggie,
      sink: issues,
      path: "hooks/hooks.json",
    })
    expect(result).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "./ok.sh --flag", timeout: 3000 }] }] },
    })
    expect(issues.blocking.map((issue) => issue.message)).toEqual([
      "Auggie cannot enforce Cognia agent selectors",
      expect.stringContaining("script files only"),
      "Managed fail-closed hook policies require the Cognia host",
      'Auggie does not execute "http" hook handlers',
    ])
  })
})
