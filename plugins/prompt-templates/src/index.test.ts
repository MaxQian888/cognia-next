/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import promptTemplatesPlugin, { parseAdd } from "./index"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

type CommandResult = boolean | { handled: boolean; message?: string }
type Hooks = {
  onCommand: (
    command: string,
    argv: string[],
    context?: { sessionId?: string }
  ) => Promise<CommandResult>
}

function makeCtx(locale: "en" | "zh-CN" = "en") {
  const store = new Map<string, unknown>()
  const storage = {
    get: <T>(k: string) => Promise.resolve(store.get(k) as T | undefined),
    set: async (k: string, v: unknown) => {
      store.set(k, v)
    },
    remove: async (k: string) => {
      store.delete(k)
    },
    keys: async () => Array.from(store.keys()),
  }
  const disposers: Array<() => void> = []
  const disposePanel = jest.fn()
  const contextPanels = {
    register: jest.fn((_registration: Record<string, unknown>) => disposePanel),
    setBadge: jest.fn(),
  }
  const appendToComposer = jest.fn()
  const ctx = {
    pluginId: "cognia-prompt-templates",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    storage,
    contextPanels,
    chat: { appendToComposer },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => {
        disposers.push(dispose)
      },
    },
    i18n: {
      t: (key: string, params?: Record<string, string | number>) =>
        (LOCALES[locale][key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) =>
          params?.[name] !== undefined ? String(params[name]) : m
        ),
    },
  } as unknown as PluginContext
  const dispose = () => {
    for (const d of disposers.reverse()) d()
  }
  return { ctx, store, contextPanels, disposePanel, appendToComposer, dispose }
}

async function activate(locale: "en" | "zh-CN" = "en") {
  const harness = makeCtx(locale)
  const hooks = (await promptTemplatesPlugin.activate(harness.ctx)) as unknown as Hooks
  const run = async (command: string, argv: string[] = [], sessionId?: string) =>
    (await hooks.onCommand(command, argv, sessionId ? { sessionId } : undefined)) as {
      handled: boolean
      message: string
    }
  return { ...harness, hooks, run }
}

describe("prompt-templates (built-in)", () => {
  it("declares four commands and least-privilege permissions", () => {
    const manifest = promptTemplatesPlugin.manifest
    expect(manifest.commands?.map((c) => c.id).sort()).toEqual([
      "template",
      "template-add",
      "template-list",
      "template-remove",
    ])
    // extension:ui + session:read → the session-scoped panel; session:write →
    // appendToComposer; clipboard:write → the panel's Copy. No settings access.
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      "clipboard:write",
      "extension:ui",
      "session:read",
      "session:write",
    ])
  })

  it("ships every string in both locales, including the panel's labelKey", () => {
    expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(Object.keys(LOCALES.en).sort())
    expect(LOCALES.en["panel.label"]).toBe("Prompt Templates")
  })

  it("declines a command that isn't one of its four", async () => {
    const { hooks } = await activate()
    expect(await hooks.onCommand("someone-elses", [])).toBe(false)
  })

  it("contributes a session-scoped panel on the templates activity, disposed with the plugin", async () => {
    const { contextPanels, disposePanel, dispose } = await activate()
    expect(contextPanels.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "templates",
        activity: "templates",
        labelKey: "panel.label",
        label: "Prompt Templates",
        resourceKinds: ["session"],
        icon: "FileText",
      })
    )
    expect(disposePanel).not.toHaveBeenCalled()
    dispose()
    expect(disposePanel).toHaveBeenCalledTimes(1)
    expect(promptTemplatesPlugin.deactivate).toBeUndefined()
  })

  it("pushes the template count onto the rail badge as commands change it", async () => {
    const { run, contextPanels } = await activate()
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith("templates", 0)
    await run("template-add", ["greeting", "hello", "there"])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith("templates", 1)
    await run("template-remove", ["greeting"])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith("templates", 0)
  })

  it("/template inserts the stored body into the calling chat's composer", async () => {
    const { run, appendToComposer } = await activate()
    await run("template-add", ["greeting", "Hello,", "{{name}}!"])
    const out = await run("template", ["greeting"], "session-9")
    expect(appendToComposer).toHaveBeenCalledWith("Hello, {{name}}!", { sessionId: "session-9" })
    expect(out).toEqual({
      handled: true,
      message: 'Inserted template "greeting" into the composer.',
    })
  })

  it("/template preserves a stored multi-line body exactly", async () => {
    const { run, store, appendToComposer } = await activate()
    const body = "Review this diff:\n\n  1. correctness\n  2. tests\n"
    store.set("template:review", body)
    await run("template", ["review"])
    expect(appendToComposer).toHaveBeenCalledWith(body, undefined)
  })

  it("/template resolves names containing spaces", async () => {
    const { run, store, appendToComposer } = await activate()
    store.set("template:weekly report", "body")
    await run("template", ["weekly", "report"])
    expect(appendToComposer).toHaveBeenCalledWith("body", undefined)
  })

  it("/template reports a missing template without touching the composer", async () => {
    const { run, appendToComposer } = await activate()
    expect((await run("template", ["ghost"])).message).toBe('Template "ghost" not found.')
    expect(appendToComposer).not.toHaveBeenCalled()
  })

  it("template-list returns the saved names", async () => {
    const { run } = await activate()
    expect((await run("template-list")).message).toBe("No prompt templates saved yet.")
    await run("template-add", ["a", "body-a"])
    await run("template-add", ["b", "body-b"])
    expect((await run("template-list")).message).toBe("Saved prompt templates (2):\n\n- a\n- b")
  })

  it("template-remove deletes the entry and reports not-found truthfully", async () => {
    const { run } = await activate()
    await run("template-add", ["foo", "bar"])
    expect((await run("template-remove", ["foo"])).message).toBe('Removed template "foo".')
    expect((await run("template", ["foo"])).message).toBe('Template "foo" not found.')
    expect((await run("template-remove", ["ghost"])).message).toBe('Template "ghost" not found.')
  })

  it("each command prints its usage when required args are missing", async () => {
    const { run } = await activate()
    expect((await run("template")).message).toBe("Usage: /template <name>")
    expect((await run("template-add", ["only-a-name"])).message).toBe(
      "Usage: /template-add <name> <body>"
    )
    expect((await run("template-remove")).message).toBe("Usage: /template-remove <name>")
  })

  it("answers in the app language", async () => {
    const { run } = await activate("zh-CN")
    expect((await run("template", ["ghost"])).message).toBe("未找到模板“ghost”。")
  })
})

describe("parseAdd", () => {
  it("takes the first token as the name and the rest as the body", () => {
    expect(parseAdd(["greet", "Hello", "there"])).toEqual({ name: "greet", body: "Hello there" })
    // With the raw text the body keeps its line breaks and indentation.
    expect(parseAdd(["review", "Check:", "-", "tests"], "review Check:\n  - tests\n")).toEqual({
      name: "review",
      body: "Check:\n  - tests",
    })
    expect(parseAdd(["greet"], "greet   ")).toBeNull()
    expect(parseAdd(["greet"])).toBeNull()
    expect(parseAdd([])).toBeNull()
  })
})
