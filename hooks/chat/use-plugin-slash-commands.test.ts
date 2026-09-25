/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { describePluginCommand, usePluginSlashCommands } from "./use-plugin-slash-commands"
import { __resetPluginI18nForTesting, registerPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import {
  registerSlashCommand,
  unregisterSlashCommand,
  __resetSlashCommandsForTesting,
} from "@/lib/slash-commands/registry"

afterEach(() => {
  __resetSlashCommandsForTesting()
  __resetPluginI18nForTesting()
})

describe("usePluginSlashCommands", () => {
  it("returns registered plugin commands as composer SlashCommands", () => {
    act(() => {
      registerSlashCommand({
        id: "demo.run",
        name: "Run",
        description: "Run it",
        source: "plugin",
        handler: () => ({}),
      })
    })
    const { result } = renderHook(() => usePluginSlashCommands())
    // The projected `name` is the token the user types, which prefers the
    // declared (single-word) name over the id — see
    // `lib/slash-commands/plugin-commands.ts:slashCommandToken`.
    expect(result.current).toEqual([
      expect.objectContaining({ name: "Run", scope: "plugin", description: "Run it" }),
    ])
  })

  it("re-renders when a plugin command is added / removed", () => {
    const { result } = renderHook(() => usePluginSlashCommands())
    expect(result.current).toHaveLength(0)

    act(() => {
      registerSlashCommand({ id: "a.cmd", name: "A", source: "plugin", handler: () => ({}) })
    })
    expect(result.current.map((c) => c.name)).toEqual(["A"])

    act(() => {
      unregisterSlashCommand("a.cmd")
    })
    expect(result.current).toHaveLength(0)
  })
})

import { usePluginSlashCommandExecution } from "./use-plugin-slash-commands"
import type { SlashCommand, SlashContext } from "@/lib/slash-commands/builtin"

function executionContext(): SlashContext {
  return {
    args: "topic",
    activeSessionId: "s1",
    pushSystemMessage: jest.fn(),
  } as unknown as SlashContext
}

function pendingCommand() {
  let context!: SlashContext
  let resolve!: () => void
  const handler = jest.fn((ctx: SlashContext) => {
    context = ctx
    return new Promise<void>((done) => {
      resolve = done
    })
  })
  const command: SlashCommand = { name: "research", description: "", scope: "plugin", handler }
  return {
    command,
    get context() {
      return context
    },
    finish: () => resolve(),
  }
}

describe("usePluginSlashCommandExecution", () => {
  it("reports progress, clamps values, ignores invalid updates, and completes", async () => {
    const { result } = renderHook(() => usePluginSlashCommandExecution("s1"))
    const pending = pendingCommand()
    const context = executionContext()
    let run!: Promise<boolean>
    await act(async () => {
      run = result.current.run(pending.command, context)
    })
    expect(result.current.progress?.command).toBe("research")
    act(() => pending.context.reportProgress!(0.25, "Searching"))
    expect(result.current.progress).toMatchObject({ value: 0.25, message: "Searching" })
    act(() => pending.context.reportProgress!(NaN))
    expect(result.current.progress?.value).toBe(0.25)
    act(() => pending.context.reportProgress!(2))
    expect(result.current.progress?.value).toBe(1)
    act(() => pending.context.reportProgress!(-1))
    expect(result.current.progress?.value).toBe(0)
    pending.context.pushSystemMessage("answer")
    expect(context.pushSystemMessage).toHaveBeenCalledWith("answer")
    await act(async () => {
      pending.finish()
      expect(await run).toBe(true)
    })
    expect(result.current.progress).toBeNull()
    act(() => pending.context.reportProgress!(0.9))
    expect(result.current.progress).toBeNull()
  })

  it("cancels promptly, suppresses stale output, and isolates a replacement run", async () => {
    const { result } = renderHook(() => usePluginSlashCommandExecution("s1"))
    const old = pendingCommand()
    const next = pendingCommand()
    const context = executionContext()
    let run!: Promise<boolean>
    await act(async () => {
      run = result.current.run(old.command, context)
    })
    await act(async () => {
      expect(await result.current.run(next.command, context)).toBe(false)
    })
    expect(next.command.handler).not.toHaveBeenCalled()
    await act(async () => {
      result.current.cancel()
      expect(await run).toBe(false)
    })
    expect(old.context.signal?.aborted).toBe(true)
    expect(result.current.progress).toBeNull()
    let nextRun!: Promise<boolean>
    await act(async () => {
      nextRun = result.current.run(next.command, context)
    })
    await act(async () => {
      old.context.reportProgress!(1, "late")
      old.context.pushSystemMessage("late")
      old.finish()
    })
    expect(context.pushSystemMessage).not.toHaveBeenCalled()
    expect(result.current.progress?.message).toBeUndefined()
    await act(async () => {
      next.finish()
      await nextRun
    })
  })

  it("aborts on session change and unmount", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ id }) => usePluginSlashCommandExecution(id),
      { initialProps: { id: "s1" } }
    )
    const first = pendingCommand()
    let run!: Promise<boolean>
    await act(async () => {
      run = result.current.run(first.command, executionContext())
    })
    rerender({ id: "s2" })
    expect(await run).toBe(false)
    expect(first.context.signal?.aborted).toBe(true)
    expect(result.current.progress).toBeNull()
    const second = pendingCommand()
    await act(async () => {
      run = result.current.run(second.command, executionContext())
    })
    unmount()
    expect(await run).toBe(false)
    expect(second.context.signal?.aborted).toBe(true)
  })

  it("cleans up errors and tolerates an idle cancel or missing handler", async () => {
    const { result } = renderHook(() => usePluginSlashCommandExecution(null))
    act(() => result.current.cancel())
    expect(await result.current.run({ name: "empty" } as SlashCommand, executionContext())).toBe(
      false
    )
    await act(async () => {
      await expect(
        result.current.run(
          {
            name: "bad",
            description: "",
            scope: "plugin",
            handler: () => {
              throw new Error("failed")
            },
          } as SlashCommand,
          executionContext()
        )
      ).rejects.toThrow("failed")
    })
    expect(result.current.progress).toBeNull()
  })

  it("does not invoke a command cancelled before dispatch", async () => {
    const { result } = renderHook(() => usePluginSlashCommandExecution("s1"))
    const pending = pendingCommand()
    await act(async () => {
      const run = result.current.run(pending.command, executionContext())
      result.current.cancel()
      expect(await run).toBe(false)
    })
    expect(pending.command.handler).not.toHaveBeenCalled()
  })
})

describe("describePluginCommand", () => {
  const def = {
    id: "acme.template",
    name: "/template",
    description: "Insert a template.",
    descriptionKey: "commands.template.description",
    source: "plugin" as const,
    pluginId: "acme",
    handler: () => ({}),
  }

  beforeEach(() => {
    registerPluginI18n({
      pluginId: "acme",
      messages: {
        en: { "plugin.acme.commands.template.description": "Insert a template." },
        "zh-CN": { "plugin.acme.commands.template.description": "插入一个模板。" },
      },
    })
  })

  it("reads the description from the plugin's own bundle for the UI language", () => {
    expect(describePluginCommand(def, "zh-CN")).toBe("插入一个模板。")
  })

  it("falls back to English when the UI language has no entry", () => {
    expect(describePluginCommand(def, "ja")).toBe("Insert a template.")
  })

  it("leaves the declared description in charge without a key or a bundle entry", () => {
    expect(describePluginCommand({ ...def, descriptionKey: undefined }, "zh-CN")).toBeUndefined()
    expect(
      describePluginCommand({ ...def, descriptionKey: "commands.missing.description" }, "zh-CN")
    ).toBeUndefined()
  })
})
