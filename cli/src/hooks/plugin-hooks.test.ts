/**
 * `resolvePluginCommandHooks` — the CLI rail's plugin `commandHooks`
 * collector. Mirrors `src-tauri/src/hooks/plugin.rs`: capability-gated,
 * enabled-only, root tokens bound per install dir, deterministic order.
 */
import path from "node:path"

import type { FileReader } from "./load-hooks"
import { resolvePluginCommandHooks } from "./plugin-hooks"

const PLUGINS = "/home/.cognia/plugins"

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "guard",
    name: "Guard",
    type: "frontend",
    capabilities: ["command-hooks"],
    commandHooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "node ${COGNIA_PLUGIN_ROOT}/hooks/guard.mjs",
              async: true,
            },
          ],
        },
      ],
    },
    ...overrides,
  })
}

function deps(
  files: Record<string, string | null>,
  dirs: Record<string, string[]> = { [PLUGINS]: ["guard"] }
) {
  const readFile: FileReader = (p) => (p in files ? files[p] : null)
  const readDir = (dir: string) => dirs[dir] ?? []
  return { readFile, readDir }
}

describe("resolvePluginCommandHooks", () => {
  it("collects an enabled plugin's block and binds the install-dir token shell-quoted", () => {
    const dir = path.join(PLUGINS, "guard")
    const { readFile, readDir } = deps({ [path.join(dir, "plugin.json")]: manifest() })

    const merged = resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })

    const groups = merged.PreToolUse ?? []
    expect(groups).toHaveLength(1)
    const handler = groups[0].hooks[0] as { command: string; async?: boolean }
    // The dir lands inside the `sh -c` command text — quoting keeps install
    // roots with spaces (`~/Library/Application Support/…`) a single arg.
    expect(handler.command).toBe(`node "${dir}"/hooks/guard.mjs`)
    expect(handler.async).toBe(true)
    expect(groups[0].matcher).toBe("Bash")
  })

  it("reads the installed `manifest.json` layout and prefers it over `plugin.json`", () => {
    const dir = path.join(PLUGINS, "guard")
    const { readFile, readDir } = deps({
      [path.join(dir, "manifest.json")]: manifest({
        commandHooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo installed" }] }],
        },
      }),
      [path.join(dir, "plugin.json")]: manifest({
        commandHooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo source" }] }],
        },
      }),
    })

    const merged = resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })
    const commands = merged.PreToolUse?.map((g) => (g.hooks[0] as { command: string }).command)
    expect(commands).toEqual(["echo installed"])
  })

  it("falls back to `plugin.json` when no `manifest.json` exists", () => {
    const dir = path.join(PLUGINS, "guard")
    const { readFile, readDir } = deps({ [path.join(dir, "plugin.json")]: manifest() })

    const merged = resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })
    expect(merged.PreToolUse).toHaveLength(1)
  })

  it("binds the token without doubling a manifest's own quotes", () => {
    const dir = "/opt/my plugins/guard"
    const { readFile, readDir } = deps(
      {
        [`${dir}/plugin.json`]: manifest({
          commandHooks: {
            Stop: [
              { hooks: [{ type: "command", command: '"${COGNIA_PLUGIN_ROOT}/x.mjs" --flag' }] },
            ],
          },
        }),
      },
      { ["/opt/my plugins"]: ["guard"] }
    )

    const merged = resolvePluginCommandHooks({
      pluginDirs: ["/opt/my plugins"],
      readDir,
      readFile,
    })
    const command = (merged.Stop?.[0].hooks[0] as { command: string }).command
    expect(command).toBe(`"${dir}"/x.mjs --flag`)
  })

  it("contributes nothing without the command-hooks capability", () => {
    const dir = path.join(PLUGINS, "guard")
    const { readFile, readDir } = deps({
      [path.join(dir, "plugin.json")]: manifest({ capabilities: ["skills"] }),
    })

    expect(resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })).toEqual({})
  })

  it("skips disabled plugins, missing manifests, and malformed manifests", () => {
    const dir = path.join(PLUGINS, "guard")
    const files = {
      [path.join(dir, "plugin.json")]: manifest(),
      [path.join(PLUGINS, "broken", "plugin.json")]: "{ not json",
    }
    const { readFile, readDir } = deps(files, {
      [PLUGINS]: ["guard", "broken", "gone"],
    })

    expect(
      resolvePluginCommandHooks({
        pluginDirs: [PLUGINS],
        disabled: new Set(["guard"]),
        readDir,
        readFile,
      })
    ).toEqual({})
  })

  it("skips a commandHooks block that fails schema validation", () => {
    const dir = path.join(PLUGINS, "guard")
    const { readFile, readDir } = deps({
      [path.join(dir, "plugin.json")]: manifest({ commandHooks: "not-an-object" }),
    })

    expect(resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })).toEqual({})
  })

  it("merges multiple plugins in deterministic id order per event", () => {
    const a = path.join(PLUGINS, "aaa")
    const z = path.join(PLUGINS, "zzz")
    const { readFile, readDir } = deps(
      {
        [path.join(a, "plugin.json")]: manifest({
          id: "aaa",
          commandHooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo a" }] }],
          },
        }),
        [path.join(z, "plugin.json")]: manifest({
          id: "zzz",
          commandHooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo z" }] }],
          },
        }),
      },
      { [PLUGINS]: ["zzz", "aaa"] }
    )

    const merged = resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })
    const commands = merged.SessionStart?.map((g) => (g.hooks[0] as { command: string }).command)
    expect(commands).toEqual(["echo a", "echo z"])
  })

  it("runs a duplicate plugin id only once — the earlier root wins", () => {
    // Mirrors `discover-plugins.ts`'s first-id-wins contract: a project-scope
    // copy of an installed plugin must not stack its hooks on top of the
    // already-contributed one.
    const userDir = path.join(PLUGINS, "plug")
    const projectPlugins = "/work/.cognia/plugins"
    const projectDir = path.join(projectPlugins, "plug")
    const { readFile, readDir } = deps(
      {
        [path.join(userDir, "plugin.json")]: manifest({
          id: "plug",
          commandHooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }],
          },
        }),
        [path.join(projectDir, "plugin.json")]: manifest({
          id: "plug",
          commandHooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo project" }] }],
          },
        }),
      },
      { [PLUGINS]: ["plug"], [projectPlugins]: ["plug"] }
    )

    const merged = resolvePluginCommandHooks({
      pluginDirs: [PLUGINS, projectPlugins],
      readDir,
      readFile,
    })
    const commands = merged.SessionStart?.map((g) => (g.hooks[0] as { command: string }).command)
    expect(commands).toEqual(["echo user"])
  })

  it("binds each plugin's own root — tokens never leak across plugins", () => {
    const a = path.join(PLUGINS, "aaa")
    const b = path.join(PLUGINS, "bbb")
    const { readFile, readDir } = deps(
      {
        [path.join(a, "plugin.json")]: manifest({
          id: "aaa",
          commandHooks: {
            Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/a.mjs" }] }],
          },
        }),
        [path.join(b, "plugin.json")]: manifest({
          id: "bbb",
          commandHooks: {
            Stop: [{ hooks: [{ type: "command", command: "${CODEX_PLUGIN_ROOT}/b.mjs" }] }],
          },
        }),
      },
      { [PLUGINS]: ["aaa", "bbb"] }
    )

    const merged = resolvePluginCommandHooks({ pluginDirs: [PLUGINS], readDir, readFile })
    const commands = merged.Stop?.map((g) => (g.hooks[0] as { command: string }).command)
    expect(commands).toEqual([`"${a}"/a.mjs`, `"${b}"/b.mjs`])
  })
})
