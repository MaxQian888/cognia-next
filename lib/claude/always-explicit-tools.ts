/**
 * The tools whose every call must reach the host (ADR-0239), stamped onto a
 * resolved send as `SendOptions.alwaysExplicitTools`.
 *
 * The outbound policy engine authorizes recipients, so it has to see every
 * outbound call. The sidecar would otherwise allow some of them on its own: a
 * remembered "Allow always", a ruleset allow, bypass mode. Listing a tool
 * here stops that in `enforce` mode, and in `observe` (shadow) mode makes the
 * sidecar report the calls it let through instead, so nothing that is sent
 * changes until the person turns enforcement on.
 *
 * The list is every id in `OUTBOUND_TOOL_IDS` plus every plugin tool of the
 * turn in the `outbound` class (derived from its plugin's manifest
 * permissions, as for unattended profiles). The sidecar matches entries on the
 * registered name, so a bare id covers the tool on any MCP server.
 *
 * The IM and team send tools are not added to `HOST_TOOL_CLASSES`: that would
 * put them in an unattended profile's `outbound` class, which asks on every
 * call even in shadow mode and would park every unattended IM team run. They
 * are listed here by name instead.
 *
 * GitHub writes (phase 2) follow the GitHub category's mode instead, stamped
 * as `alwaysExplicitGithubWritesMode`: shell `gh` writes, which the gates find
 * in the command, and the turn's GitHub write actions
 * (`alwaysExplicitGithubTools`), listed by their full registered name because
 * their short names (`commentpr`) are shared with other plugins' tools.
 */

import type { SendOptions } from "@cognia/agent-config-types"

import type { OutboundAuthorizationMode } from "@/lib/policy/action-review/policy"
import { isGithubWriteTool } from "@/lib/policy/action-review/github-targets"
import { normalizeToolId, OUTBOUND_TOOL_IDS } from "@/lib/policy/risk/outbound-tools"

import { classesForPluginTool } from "./unattended-permission-options"

type PluginTool = NonNullable<SendOptions["pluginTools"]>[number]

export interface AlwaysExplicitToolsDeps {
  /** The messaging mode. */
  mode: OutboundAuthorizationMode
  /** The GitHub category's mode, for GitHub writes. */
  githubMode: OutboundAuthorizationMode
  /** The declaring plugin's manifest permissions, or empty when it has none. */
  pluginPermissions: (pluginId: string) => readonly string[]
}

/** The normalized names to list for a turn with `pluginTools`, sorted. */
export function alwaysExplicitToolNames(
  pluginTools: readonly PluginTool[] | undefined,
  pluginPermissions: AlwaysExplicitToolsDeps["pluginPermissions"]
): string[] {
  const names = new Set<string>(OUTBOUND_TOOL_IDS)
  for (const tool of pluginTools ?? []) {
    if (classesForPluginTool(tool, pluginPermissions(tool.pluginId)).includes("outbound")) {
      names.add(normalizeToolId(tool.name))
    }
  }
  return [...names].sort()
}

/** The turn's GitHub write actions, by full registered name, lowercased and sorted. */
export function alwaysExplicitGithubToolNames(
  pluginTools: readonly PluginTool[] | undefined
): string[] {
  const names = new Set<string>()
  for (const tool of pluginTools ?? []) {
    if (isGithubWriteTool(tool.name)) names.add(tool.name.trim().toLowerCase())
  }
  return [...names].sort()
}

/** Stamp the lists and their modes. Shadow mode observes; only `enforce` enforces. */
export function applyAlwaysExplicitTools(
  opts: SendOptions,
  deps: AlwaysExplicitToolsDeps
): SendOptions {
  opts.alwaysExplicitTools = alwaysExplicitToolNames(opts.pluginTools, deps.pluginPermissions)
  opts.alwaysExplicitToolsMode = deps.mode === "enforce" ? "enforce" : "observe"
  opts.alwaysExplicitGithubWritesMode = deps.githubMode === "enforce" ? "enforce" : "observe"
  const githubTools = alwaysExplicitGithubToolNames(opts.pluginTools)
  if (githubTools.length > 0) opts.alwaysExplicitGithubTools = githubTools
  else delete opts.alwaysExplicitGithubTools
  return opts
}
