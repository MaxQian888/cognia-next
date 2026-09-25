/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import clipboardHistory, {
  MIN_POLL_INTERVAL_MS,
  normalizeConfig,
  toCodeSpan,
  type ClipboardEntry,
} from "./index"

type ToolExecute = (args: Record<string, unknown>, callCtx: { config: object }) => Promise<unknown>
type Hooks = {
  onCommand: (c: string, a: string[]) => Promise<boolean | { handled: boolean; message?: string }>
  onConfigChange: (config: Record<string, unknown>) => void
}

const EN: Record<string, string> = {
  "command.empty": "Clipboard history is empty.",
  "command.header": "Recent clipboard entries ({shown} of {total}, newest first):",
  "command.privacyNote": "Privacy mode is on: new captures are kept in memory only.",
}

function makeCtx(config: Record<string, unknown> = {}) {
  const tools: Record<string, ToolExecute> = {}
  const definitions: Record<string, { requiresApproval?: boolean; access?: string }> = {}
  const secureStore = new Map<string, unknown>()
  const disposers: Array<() => void | Promise<void>> = []
  const readText = jest.fn(async () => "")
  const registerToolResultRenderer = jest.fn((_tool: string, _render: unknown) => () => {})
  const warn = jest.fn()
  const ctx = {
    pluginId: "cognia-clipboard-history",
    config,
    logger: { info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => {
        disposers.push(dispose)
      },
    },
    clipboard: { readText },
    toolResult: { registerToolResultRenderer },
    i18n: {
      t: (key: string, params?: Record<string, string | number>) =>
        (EN[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) =>
          params?.[name] !== undefined ? String(params[name]) : m
        ),
      formatRelativeTime: () => "just now",
    },
    storage: {
      setSecure: async (k: string, v: unknown) => {
        secureStore.set(k, v)
      },
      getSecure: async <T>(k: string) => secureStore.get(k) as T | undefined,
    },
    agent: {
      registerTool: (tool: {
        name: string
        definition: { requiresApproval?: boolean; access?: string }
        execute: ToolExecute
      }) => {
        tools[tool.name] = tool.execute
        definitions[tool.name] = tool.definition
      },
    },
  } as unknown as PluginContext
  const dispose = async () => {
    for (const d of disposers.reverse()) await d()
  }
  return {
    ctx,
    tools,
    definitions,
    secureStore,
    readText,
    registerToolResultRenderer,
    warn,
    dispose,
  }
}

async function activate(config: Record<string, unknown> = {}) {
  const harness = makeCtx(config)
  const hooks = (await clipboardHistory.activate(harness.ctx)) as unknown as Hooks
  return { ...harness, hooks }
}

const call = (config: Record<string, unknown> = {}) => ({ config })

afterEach(() => {
  jest.useRealTimers()
})

describe("clipboard-history (built-in)", () => {
  it("registers three tools, the result card, and one declared slash command", async () => {
    const { tools, definitions, registerToolResultRenderer, dispose } = await activate()
    expect(Object.keys(tools).sort()).toEqual([
      "clipboard_history_add",
      "clipboard_history_clear",
      "clipboard_history_list",
    ])
    expect(registerToolResultRenderer).toHaveBeenCalledWith(
      "clipboard_history_list",
      expect.any(Function)
    )
    expect((clipboardHistory.manifest as { commands?: unknown[] }).commands).toHaveLength(1)
    // Wiping the user's history needs approval; none of the tools touch files.
    expect(definitions.clipboard_history_clear.requiresApproval).toBe(true)
    for (const def of Object.values(definitions)) expect(def.access).toBeUndefined()
    await dispose()
  })

  it("declares least-privilege permissions and a truthful browser posture", () => {
    const manifest = clipboardHistory.manifest
    expect(manifest.permissions).toEqual(["clipboard:read", "extension:ui"])
    expect(manifest.runtimeCompatibility?.browser).toMatchObject({ availability: "degraded" })
    expect(manifest.runtimeCompatibility?.browser?.reason).toEqual(expect.any(String))
  })

  it("clipboard_history_add stores entries in the secure buffer", async () => {
    const { tools, secureStore, dispose } = await activate()
    await expect(tools.clipboard_history_add({ text: "alpha" }, call())).resolves.toEqual({
      ok: true,
      added: true,
      persisted: true,
    })
    await tools.clipboard_history_add({ text: "beta" }, call())
    expect((secureStore.get("buffer") as ClipboardEntry[]).map((e) => e.text)).toEqual([
      "alpha",
      "beta",
    ])
    await dispose()
  })

  it("rejects an empty add with an actionable error", async () => {
    const { tools, dispose } = await activate()
    await expect(tools.clipboard_history_add({}, call())).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/text/),
    })
    await dispose()
  })

  it("does not push duplicate consecutive entries", async () => {
    const { tools, dispose } = await activate()
    await tools.clipboard_history_add({ text: "alpha" }, call())
    const second = (await tools.clipboard_history_add({ text: "alpha" }, call())) as {
      added: boolean
    }
    expect(second.added).toBe(false)
    await dispose()
  })

  it("trims the buffer to the per-call maxEntries", async () => {
    const { tools, secureStore, dispose } = await activate()
    for (const text of ["a", "b", "c"]) {
      await tools.clipboard_history_add({ text }, call({ maxEntries: 2 }))
    }
    expect((secureStore.get("buffer") as ClipboardEntry[]).map((e) => e.text)).toEqual(["b", "c"])
    await dispose()
  })

  it("privacy mode keeps the latest entry in memory only, read from the live call config", async () => {
    // Activated with privacy OFF — the call config is what counts.
    const { tools, secureStore, dispose } = await activate({ privacyMode: false })
    const result = await tools.clipboard_history_add(
      { text: "secret" },
      call({ privacyMode: true })
    )
    expect(result).toEqual({ ok: true, added: true, persisted: false })
    expect(secureStore.get("buffer")).toBeUndefined()
    const listed = (await tools.clipboard_history_list({}, call({ privacyMode: true }))) as {
      privacyMode: boolean
      entries: ClipboardEntry[]
    }
    expect(listed.privacyMode).toBe(true)
    expect(listed.entries.map((e) => e.text)).toEqual(["secret"])
    await dispose()
  })

  it("clear empties the persisted buffer and the in-memory latest", async () => {
    const { tools, secureStore, dispose } = await activate()
    await tools.clipboard_history_add({ text: "x" }, call())
    await tools.clipboard_history_add({ text: "y" }, call({ privacyMode: true }))
    await tools.clipboard_history_clear({}, call())
    expect(secureStore.get("buffer")).toEqual([])
    const listed = (await tools.clipboard_history_list({}, call())) as { entries: unknown[] }
    expect(listed.entries).toEqual([])
    await dispose()
  })

  it("the declared command answers in chat with localized empty and list messages", async () => {
    const { hooks, tools, dispose } = await activate()
    expect(await hooks.onCommand("not-mine", [])).toBe(false)
    await expect(hooks.onCommand("clipboard-history", [])).resolves.toEqual({
      handled: true,
      message: "Clipboard history is empty.",
    })
    await tools.clipboard_history_add({ text: "first" }, call())
    await tools.clipboard_history_add({ text: "has `code` and [a](link)" }, call())
    const result = (await hooks.onCommand("clipboard-history", [])) as {
      handled: boolean
      message: string
    }
    expect(result.handled).toBe(true)
    expect(result.message).toContain("Recent clipboard entries (2 of 2, newest first):")
    // Newest first, and untrusted clipboard text stays inside a code span.
    expect(result.message).toContain("1. just now — `` has `code` and [a](link) ``")
    expect(result.message).toContain("2. just now — ` first `")
    await dispose()
  })

  it("polls through ctx.clipboard.readText and persists the capture", async () => {
    jest.useFakeTimers()
    const { readText, secureStore, dispose } = await activate({ pollIntervalMs: 1000 })
    readText.mockResolvedValue("desktop copied text")
    await jest.advanceTimersByTimeAsync(1000)
    expect(readText).toHaveBeenCalled()
    const buffer = secureStore.get("buffer") as ClipboardEntry[] | undefined
    expect(buffer?.some((e) => e.text === "desktop copied text")).toBe(true)
    await dispose()
  })

  it("restarts the poller on a config change and stops it on dispose", async () => {
    jest.useFakeTimers()
    const { hooks, readText, dispose } = await activate({ pollIntervalMs: 0 })
    await jest.advanceTimersByTimeAsync(5000)
    expect(readText).not.toHaveBeenCalled()
    hooks.onConfigChange({ pollIntervalMs: 2000 })
    await jest.advanceTimersByTimeAsync(2000)
    expect(readText).toHaveBeenCalledTimes(1)
    await dispose()
    await jest.advanceTimersByTimeAsync(10_000)
    expect(readText).toHaveBeenCalledTimes(1)
  })

  it("logs a failing poll once instead of on every tick", async () => {
    jest.useFakeTimers()
    const { readText, warn, dispose } = await activate({ pollIntervalMs: 1000 })
    readText.mockRejectedValue(new Error("Document is not focused"))
    await jest.advanceTimersByTimeAsync(3000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/poll failed: Document is not focused/))
    await dispose()
  })
})

describe("normalizeConfig", () => {
  it("applies defaults and raises a sub-second poll interval to the rate-limit floor", () => {
    expect(normalizeConfig(undefined)).toEqual({
      maxEntries: 50,
      privacyMode: false,
      pollIntervalMs: 0,
    })
    expect(normalizeConfig({ pollIntervalMs: 10, maxEntries: 0 })).toEqual({
      maxEntries: 50,
      privacyMode: false,
      pollIntervalMs: MIN_POLL_INTERVAL_MS,
    })
  })
})

describe("toCodeSpan", () => {
  it("fences with one more backtick than the longest run inside", () => {
    expect(toCodeSpan("plain")).toBe("` plain `")
    expect(toCodeSpan("a ``b`` c")).toBe("``` a ``b`` c ```")
  })
})
