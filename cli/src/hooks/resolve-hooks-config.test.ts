/** @jest-environment node */
import { hasAnyHookGroup, resolveCliHooksConfig } from "./resolve-hooks-config"
import type { HooksConfig } from "./types"

const HOME = "/home/.cognia"

function reader(files: Record<string, unknown>) {
  return (absPath: string): string | null => {
    for (const [suffix, body] of Object.entries(files)) {
      if (absPath.endsWith(suffix)) return JSON.stringify(body)
    }
    return null
  }
}

describe("resolveCliHooksConfig", () => {
  it("merges cognia config, ~/.claude/settings.json and the built-ins", () => {
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      builtinHooksDir: "/bundle/hooks/builtin",
      readFile: reader({
        "config.json": {
          hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "a.sh" }] }] },
        },
        "settings.json": {
          hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "b.sh" }] }] },
        },
      }),
    })

    const commands = (config.PreToolUse ?? []).flatMap((g) =>
      g.hooks.map((h) => (h as { command?: string }).command ?? "")
    )
    // Cognia first, then Claude, then built-ins underneath — so a user hook can
    // block before a product-bundled one ever runs.
    expect(commands.slice(0, 2)).toEqual(["a.sh", "b.sh"])
    expect(commands.some((c) => c.includes("pii-safety-guard.mjs"))).toBe(false)
  })

  it("carries the default-on built-ins when the user has no hooks", () => {
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      builtinHooksDir: "/bundle/hooks/builtin",
      readFile: () => null,
    })
    // `auto-context-loader` ships enabled. Before the CLI injected this config,
    // it ran through a runner that never parsed stdout, so its
    // `additionalContext` was silently discarded on this rail.
    const commands = (config.UserPromptSubmit ?? []).flatMap((g) =>
      g.hooks.map((h) => (h as { command?: string }).command ?? "")
    )
    expect(commands.some((c) => c.includes("auto-context-loader.mjs"))).toBe(true)
  })

  it("honours built-in overrides", () => {
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      builtinHooksDir: "/bundle/hooks/builtin",
      builtinHookOverrides: {
        "auto-context-loader": false,
        "auto-context-loader-prompt": false,
      },
      readFile: () => null,
    })
    expect(hasAnyHookGroup(config)).toBe(false)
  })

  it("merges enabled plugins' commandHooks under user groups and above built-ins", () => {
    const pluginManifest = JSON.stringify({
      id: "guard",
      name: "Guard",
      type: "frontend",
      capabilities: ["command-hooks"],
      commandHooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "${COGNIA_PLUGIN_ROOT}/guard.mjs" }],
          },
        ],
      },
    })
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      cwd: "/work",
      isTrustedFolder: () => true,
      builtinHooksDir: "/bundle/hooks/builtin",
      readDir: (dir) => (dir === "/home/.cognia/.cognia/plugins" ? ["guard"] : []),
      readFile: (absPath) => {
        if (absPath.endsWith("config.json")) {
          return JSON.stringify({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "user.sh" }] }] },
          })
        }
        if (absPath.endsWith("plugin.json")) return pluginManifest
        return null
      },
    })

    const commands = (config.PreToolUse ?? []).map(
      (g) => (g.hooks[0] as { command?: string }).command ?? ""
    )
    // user group first, then the plugin's (root token bound) — any
    // default-on built-ins land after both.
    expect(commands.slice(0, 2)).toEqual([
      "user.sh",
      '"/home/.cognia/.cognia/plugins/guard"/guard.mjs',
    ])
  })

  it("scans the COGNIA_DATA_DIR root where cognia-server installs plugins", () => {
    const dataDir = "/data-dir"
    process.env.COGNIA_DATA_DIR = dataDir
    try {
      const config = resolveCliHooksConfig({
        home: HOME,
        osHome: "/home",
        builtinHooksDir: "/bundle/hooks/builtin",
        readDir: (dir) => (dir === `${dataDir}/.cognia/plugins` ? ["guard"] : []),
        readFile: (absPath) =>
          absPath.endsWith("manifest.json")
            ? JSON.stringify({
                id: "guard",
                name: "Guard",
                type: "frontend",
                capabilities: ["command-hooks"],
                commandHooks: {
                  SessionStart: [{ hooks: [{ type: "command", command: "echo data-scope" }] }],
                },
              })
            : null,
      })

      const commands = (config.SessionStart ?? []).flatMap((g) =>
        g.hooks.map((h) => (h as { command?: string }).command ?? "")
      )
      expect(commands).toContain("echo data-scope")
    } finally {
      delete process.env.COGNIA_DATA_DIR
    }
  })

  it("does not run repository-controlled project hooks until the folder is trusted", () => {
    const projectPlugins = "/work/.cognia/plugins"
    const readFile = (absPath: string) =>
      absPath.endsWith("manifest.json")
        ? JSON.stringify({
            id: "guard",
            name: "Guard",
            type: "frontend",
            capabilities: ["command-hooks"],
            commandHooks: {
              UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo repo-owned" }] }],
            },
          })
        : null
    const readDir = (dir: string) => (dir === projectPlugins ? ["guard"] : [])

    // Untrusted project → the manifest never even feeds the merge.
    const untrusted = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      cwd: "/work",
      isTrustedFolder: () => false,
      builtinHooksDir: "/bundle/hooks/builtin",
      readDir,
      readFile,
    })
    expect(
      (untrusted.UserPromptSubmit ?? []).flatMap((g) =>
        g.hooks.map((h) => (h as { command?: string }).command ?? "")
      )
    ).not.toContain("echo repo-owned")

    // Once the folder is trusted the same manifest contributes its hooks.
    const trusted = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      cwd: "/work",
      isTrustedFolder: (home, cwd) => home === HOME && cwd === "/work",
      builtinHooksDir: "/bundle/hooks/builtin",
      readDir,
      readFile,
    })
    expect(
      (trusted.UserPromptSubmit ?? []).flatMap((g) =>
        g.hooks.map((h) => (h as { command?: string }).command ?? "")
      )
    ).toContain("echo repo-owned")
  })

  it("omits the plugin layer entirely when no plugin contributes", () => {
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      builtinHooksDir: "/bundle/hooks/builtin",
      builtinHookOverrides: {
        "auto-context-loader": false,
        "auto-context-loader-prompt": false,
        "cost-quota-guard": false,
        "pii-safety-guard": false,
        "pii-safety-guard-tool": false,
        "tool-provenance-guard": false,
        "command-auth-gate": false,
      },
      readDir: () => [],
      readFile: () => null,
    })
    expect(hasAnyHookGroup(config)).toBe(false)
  })

  it("strips fleet groups so the monitor's own hooks are not re-run", () => {
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      builtinHooksDir: "/bundle/hooks/builtin",
      builtinHookOverrides: {
        "auto-context-loader": false,
        "auto-context-loader-prompt": false,
      },
      readFile: reader({
        "settings.json": {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "/x/agent-monitor/claude-hook.sh" }] },
            ],
          },
        },
      }),
    })
    expect(hasAnyHookGroup(config)).toBe(false)
  })

  it("never throws on an unreadable config, and keeps the built-ins working", () => {
    // A misconfigured or unreadable user config must never stop the agent from
    // running. `readHooksBlock` already swallows the read error per file, so the
    // degraded result is "product built-ins only" rather than "nothing".
    const config = resolveCliHooksConfig({
      home: HOME,
      osHome: "/home",
      builtinHooksDir: "/bundle/hooks/builtin",
      readFile: () => {
        throw new Error("disk on fire")
      },
    })
    const commands = (config.UserPromptSubmit ?? []).flatMap((g) =>
      g.hooks.map((h) => (h as { command?: string }).command ?? "")
    )
    expect(commands.some((c) => c.includes("auto-context-loader.mjs"))).toBe(true)
  })

  it("degrades to an empty block if the whole resolve blows up", () => {
    // The outer guard: anything unexpected (a throwing builtin resolver, a bad
    // home path) must still yield a usable, inert config.
    const config = resolveCliHooksConfig({
      home: null as unknown as string,
      osHome: null as unknown as string,
      builtinHooksDir: null as unknown as string,
      readFile: () => null,
    })
    expect(hasAnyHookGroup(config)).toBe(false)
  })
})

describe("hasAnyHookGroup", () => {
  it("is false for absent, empty, and key-but-no-group configs", () => {
    expect(hasAnyHookGroup(undefined)).toBe(false)
    expect(hasAnyHookGroup(null)).toBe(false)
    expect(hasAnyHookGroup({})).toBe(false)
    // The distinction that matters: a key with an empty array must NOT count as
    // injectable, or the CLI runner would stand down for nothing.
    expect(hasAnyHookGroup({ PreToolUse: [] } as HooksConfig)).toBe(false)
  })

  it("is true once any event carries a group", () => {
    expect(
      hasAnyHookGroup({ Stop: [{ hooks: [{ type: "command", command: "x" }] }] } as HooksConfig)
    ).toBe(true)
  })
})
