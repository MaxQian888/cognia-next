/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import { listSlashCommandsByPlugin } from "@cognia/plugin-sdk/api/slash-command"
import promptTemplatesPlugin from "./index"

/**
 * Asserted against the REAL registry rather than a mock of the host module:
 * this plugin declares its commands in the manifest and must leave the
 * registry alone, and "the registry has nothing of mine in it" is a stronger
 * claim than "the function I stubbed was not called".
 */
const PLUGIN_ID = "cognia-prompt-templates"

function makeCtx() {
  const store = new Map<string, unknown>()
  const storage = {
    get: <T>(k: string) => Promise.resolve(store.get(k) as T | undefined),
    set: async (k: string, v: unknown) => {
      store.set(k, v)
    },
    remove: async (k: string) => {
      store.delete(k)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
    has: async (k: string) => store.has(k),
    keys: async () => Array.from(store.keys()),
    clear: async () => store.clear(),
    getOrDefault: async <T>(k: string, d: T) => (store.get(k) as T) ?? d,
    getUsage: async () => 0,
    setSecure: async () => {},
    getSecure: async () => undefined,
    isEncrypted: async () => false,
  }
  const showToast = jest.fn()
  const disposePanel = jest.fn()
  const contextPanels = {
    register: jest.fn(() => disposePanel),
    setBadge: jest.fn(),
  }
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-prompt-templates",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    storage: storage as never,
    ui: { showToast } as never,
    contextPanels: contextPanels as never,
  }
  return { ctx: ctx as PluginContext, store, showToast, contextPanels, disposePanel }
}

beforeEach(() => {})

describe("prompt-templates (built-in)", () => {
  /** Activate and return the declared-command hook + the toast spy. */
  async function activate() {
    const { ctx, showToast } = makeCtx()
    const hooks = (await promptTemplatesPlugin.activate?.(ctx)) as unknown as {
      onCommand: (command: string, argv: string[]) => Promise<boolean>
    }
    const run = async (command: string, args = "") => {
      showToast.mockClear()
      const handled = await hooks.onCommand(command, args ? args.split(/\s+/) : [])
      return { handled, message: String(showToast.mock.calls[0]?.[0] ?? "") }
    }
    return { run, showToast }
  }

  it("declares four commands instead of registering them", async () => {
    const { ctx } = makeCtx()
    await promptTemplatesPlugin.activate?.(ctx)
    // The manager owns registration for manifest-declared commands.
    expect(listSlashCommandsByPlugin(PLUGIN_ID)).toEqual([])
    const commands = (promptTemplatesPlugin.manifest as { commands?: Array<{ id: string }> })
      .commands
    expect(commands?.map((c) => c.id).sort()).toEqual([
      "template",
      "template-add",
      "template-list",
      "template-remove",
    ])
  })

  it("declines a command that isn't one of its four", async () => {
    const { run } = await activate()
    expect((await run("someone-elses")).handled).toBe(false)
  })

  it("contributes a session-scoped panel on the templates activity", async () => {
    const { ctx, contextPanels } = makeCtx()
    await promptTemplatesPlugin.activate?.(ctx)

    // `session` is the dock's fallback resource, so this is what makes the
    // panel reachable in the right rail's default state. `templates` is the one
    // canonical activity with no native panel behind it.
    expect(contextPanels.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "templates",
        activity: "templates",
        resourceKinds: ["session"],
        icon: "FileText",
      })
    )
  })

  it("pushes the template count onto the rail badge as commands change it", async () => {
    const { ctx, contextPanels } = makeCtx()
    const hooks = (await promptTemplatesPlugin.activate?.(ctx)) as unknown as {
      onCommand: (command: string, argv: string[]) => Promise<boolean>
    }

    expect(contextPanels.setBadge).toHaveBeenLastCalledWith("templates", 0)
    await hooks.onCommand("template-add", ["greeting", "hello", "there"])
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith("templates", 1)
    await hooks.onCommand("template-remove", ["greeting"])
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith("templates", 0)
  })

  it("unregisters the panel when the plugin deactivates", async () => {
    const { ctx, disposePanel } = makeCtx()
    const hooks = (await promptTemplatesPlugin.activate?.(ctx)) as unknown as {
      onCommand: (command: string, argv: string[]) => Promise<boolean>
      onDeactivate?: () => void
    }

    expect(hooks.onDeactivate).toBeUndefined()
    expect(disposePanel).not.toHaveBeenCalled()
    await promptTemplatesPlugin.deactivate?.(ctx)
    expect(disposePanel).toHaveBeenCalledTimes(1)
  })

  it("template-add then template returns the stored body", async () => {
    const { run } = await activate()
    expect((await run("template-add", "greeting Hello, {{name}}!")).message).toContain("greeting")
    expect((await run("template", "greeting")).message).toContain("Hello, {{name}}!")
  })

  it("template-list returns the saved names", async () => {
    const { run } = await activate()
    await run("template-add", "a body-a")
    await run("template-add", "b body-b")
    const out = await run("template-list")
    expect(out.message).toContain("a")
    expect(out.message).toContain("b")
  })

  it("template-remove deletes the entry", async () => {
    const { run } = await activate()
    await run("template-add", "foo bar")
    expect((await run("template-remove", "foo")).message).toContain("Removed")
    expect((await run("template", "foo")).message).toContain("not found")
  })

  it("template-remove reports not-found instead of a false success", async () => {
    // It used to answer `Removed template "ghost".` for a name that never
    // existed.
    const { run } = await activate()
    expect((await run("template-remove", "ghost")).message).toContain("not found")
  })

  it("each command prints its usage when required args are missing", async () => {
    const { run } = await activate()
    expect((await run("template")).message).toContain("Usage: /template <name>")
    expect((await run("template-add")).message).toContain("Usage: /template-add")
    expect((await run("template-remove")).message).toContain("Usage: /template-remove")
  })

  it("leaves command teardown to the manager", async () => {
    expect(promptTemplatesPlugin.deactivate).toEqual(expect.any(Function))
    expect(listSlashCommandsByPlugin(PLUGIN_ID)).toEqual([])
  })
})
