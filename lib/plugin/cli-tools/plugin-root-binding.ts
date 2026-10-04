/**
 * Plugin-root token binding for declarative CLI tools (`manifest.cliTools`).
 *
 * A cliTool often needs to point its program at a file the plugin ships —
 * `node ${COGNIA_PLUGIN_ROOT}/vendor/cli.ts` — while running with the user's
 * workspace as cwd. The token family from `plugin-root-tokens.ts` is bound to
 * the plugin's real install directory, but ONLY in the two static places the
 * manifest author controls:
 *
 *   - `{ literal }` argv tokens, and
 *   - static `env` values.
 *
 * Parameter values are never expanded: they come from the model, and a model
 * that types `${COGNIA_PLUGIN_ROOT}` must get that literal string, not the
 * install path (the same "params never reach env / never shape the program"
 * rule the executor already enforces). `eachPrefixedBy` flags are left alone
 * for the same reason — they are flag spellings, not paths.
 *
 * A `builtin://` plugin (or one without an install path) has no directory a
 * spawned process could read, so a tool that references the token there is
 * refused with a template error instead of running with a dangling path.
 */

import type { PluginCliArgvToken, PluginCliToolDef } from "@/types/plugin"
import { PLUGIN_ROOT_TOKENS, replacePluginRootTokens } from "@/lib/plugin/utils/plugin-root-tokens"
import { CliTemplateError } from "./template"

/** The first plugin-root token spelled in `value`, if any. Pure. */
export function findPluginRootToken(value: string): string | undefined {
  return PLUGIN_ROOT_TOKENS.find((token) => value.includes(token))
}

/** True for pseudo-paths that are not a directory on disk (`builtin://x`, `asset://x`). */
function isPseudoRoot(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)
}

export interface BoundCliToolTemplate {
  argv: PluginCliArgvToken[]
  env: Record<string, string>
}

/**
 * Bind plugin-root tokens in `def`'s literal argv tokens and static env
 * values to `pluginPath`. Returns the manifest values unchanged when the tool
 * references no token. Throws `CliTemplateError` when it does but the plugin
 * has no on-disk install directory. Pure.
 */
export function bindCliToolPluginRoot(
  def: Pick<PluginCliToolDef, "name" | "argv" | "env">,
  pluginPath: string
): BoundCliToolTemplate {
  const env = def.env ?? {}
  const referenced =
    def.argv
      .map((token) =>
        "literal" in token && typeof token.literal === "string"
          ? findPluginRootToken(token.literal)
          : undefined
      )
      .find((token) => token !== undefined) ??
    Object.values(env)
      .map((value) => findPluginRootToken(value))
      .find((token) => token !== undefined)

  if (referenced === undefined) {
    return { argv: def.argv, env }
  }

  const root = pluginPath.replace(/[\\/]+$/, "")
  if (!root || isPseudoRoot(root)) {
    throw new CliTemplateError(
      `cliTool "${def.name}" references ${referenced}, but the plugin has no on-disk install ` +
        `directory (${pluginPath ? `install path "${pluginPath}"` : "no install path"}); ` +
        "plugin-root tokens only bind for plugins installed from a directory or archive"
    )
  }

  return {
    argv: def.argv.map((token) =>
      "literal" in token && typeof token.literal === "string"
        ? { literal: replacePluginRootTokens(token.literal, root) }
        : token
    ),
    env: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, replacePluginRootTokens(value, root)])
    ),
  }
}
