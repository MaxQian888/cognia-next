/**
 * `/plugin` controller — discover, inspect, toggle, reload, install, uninstall
 * plugins, and browse a Claude-Code-style GitHub marketplace.
 *
 * Source of truth is the live `PluginManager` store (the SAME one the desktop
 * uses), which the CLI bootstraps with both builtins and disk plugins
 * (`cli/src/plugin/host.ts`). enable/disable/reload/install/uninstall all go
 * through the manager so a plugin's tools actually reach the model; the file
 * overlay (`plugin-state.json`) persists the disabled set across launches. The
 * App fires `agent.invalidate()` after every `plugin` runtime request, so a
 * change reaches the next turn's tool manifest.
 */
import type { PluginInfo, PluginToolInfo } from "../../plugin/discover-plugins"
import { readDisabledPlugins, setPluginDisabled } from "../../plugin/plugin-state"
import {
  readSources,
  addSource as addSourceToStore,
  removeSource as removeSourceFromStore,
} from "../../plugin/marketplace-sources"
import { openDocument } from "./shared"
import { buildToolsDocument } from "./tool-doc"
import type { TuiAction } from "../state/types"
import type { PluginManifest, PluginPermission } from "@/types/plugin"

export interface PluginDeps {
  dispatch: (action: TuiAction) => void
  roots: string[]
  home: string
  /** Unified plugin list (manager store). Default reads `usePluginStore`. */
  list?: () => Promise<PluginInfo[]>
  getDisabled?: () => Set<string>
  /** Persist the disabled-set overlay. Default writes `plugin-state.json`. */
  setEnabled?: (id: string, disabled: boolean) => void
  /** Flip the LIVE manager so the change reaches the next turn. */
  setLive?: (id: string, enabled: boolean) => Promise<void>
  /** Hot-reload a plugin via the manager. */
  reload?: (id: string) => Promise<void>
  /** Uninstall a plugin (unload + remove dir). */
  uninstall?: (id: string) => Promise<void>
  /** Fetch a GitHub install preview (manifest) for the consent summary. */
  preview?: (ref: string) => Promise<{ manifest: PluginManifest }>
  /** Whether a plugin id is already installed (for the conflict note). */
  isInstalled?: (id: string) => boolean
  /** Perform the real install (download + register + enable). */
  install?: (ref: string) => Promise<{ id: string }>
  /** Marketplace source list. */
  getSources?: () => string[]
  addSource?: (ref: string) => void
  removeSource?: (ref: string) => void
  /** Fetch merged catalog entries from the configured sources. */
  browse?: (sources: string[]) => Promise<{
    entries: Array<{ name: string; installRef: string; description?: string }>
    errors: Array<{ repoRef: string; message: string }>
  }>
}

// ── unified list (manager store) ──────────────────────────────────────────────

/** Map a store plugin row to the `PluginInfo` the list/show/tools render. */
export function toPluginInfo(p: { manifest: PluginManifest; path: string }): PluginInfo {
  const m = p.manifest
  const rawTools = (m as { tools?: unknown }).tools
  const tools: PluginToolInfo[] = Array.isArray(rawTools)
    ? rawTools
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .filter((t) => typeof t.name === "string")
        .map((t) => ({
          name: t.name as string,
          description: typeof t.description === "string" ? t.description : "",
          ...(typeof t.category === "string" ? { category: t.category } : {}),
          ...(t.parametersSchema && typeof t.parametersSchema === "object"
            ? { parametersSchema: t.parametersSchema as Record<string, unknown> }
            : {}),
        }))
    : []
  return {
    id: m.id,
    name: m.name ?? m.id,
    version: m.version ?? "0.0.0",
    description: typeof m.description === "string" ? m.description : "",
    type: m.type,
    dir: p.path,
    supported: m.type === "frontend",
    tools,
    mcpServerPresets: [],
  }
}

async function defaultListPlugins(): Promise<PluginInfo[]> {
  const { usePluginStore } = await import("@/stores/plugin-runtime")
  const plugins = usePluginStore.getState().plugins as unknown as Record<
    string,
    { manifest: PluginManifest; path: string }
  >
  return Object.values(plugins).map(toPluginInfo)
}

const loadPlugins = (deps: PluginDeps) => (deps.list ?? defaultListPlugins)()
const disabledOf = (deps: PluginDeps) =>
  (deps.getDisabled ?? (() => readDisabledPlugins(deps.home)))()

// ── default live-manager wiring (lazy; injected in tests) ───────────────────────

async function realHost(): Promise<
  import("../../plugin/host").HostManager & {
    pluginDir: (id: string) => string | undefined
  }
> {
  const { getPluginManager } = await import("@/lib/plugin/core/manager")
  const { usePluginStore } = await import("@/stores/plugin-runtime")
  const { makeHostManager } = await import("../../plugin/host-manager")
  const getPlugins = () =>
    usePluginStore.getState().plugins as unknown as Record<
      string,
      { manifest: PluginManifest; path: string; status: string }
    >
  const hm = makeHostManager({ manager: getPluginManager() as never, getPlugins })
  return { ...hm, pluginDir: (id) => getPlugins()[id]?.path }
}

// ── list / show / tools ─────────────────────────────────────────────────────────

export async function pluginList(deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  if (plugins.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No plugins installed. Try /plugin marketplace or drop a folder under .cognia/plugins/.",
    })
    return
  }
  const disabled = disabledOf(deps)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Plugins (Enter inspects)",
      items: plugins.map((p) => ({
        id: p.id,
        label: p.name,
        hint: `${p.type}${p.supported ? "" : " · unsupported"} · ${
          disabled.has(p.id) ? "off" : "on"
        }`,
      })),
      index: 0,
      onSelectCommand: "plugin show",
    },
  })
}

/** Render a plugin's detail as a markdown document. Pure (unit-tested raw). */
export function buildPluginDocument(plugin: PluginInfo, enabled: boolean): string {
  const support = plugin.supported
    ? "runnable in CLI"
    : `not runnable in CLI (${plugin.type} needs the desktop host)`
  const lines: string[] = [
    `# ${plugin.name}`,
    "",
    `\`${plugin.id}\` · v${plugin.version} · ${plugin.type} · ${enabled ? "enabled" : "disabled"}`,
    "",
    `_${support}_`,
    "",
  ]
  if (plugin.description) lines.push(`> ${plugin.description}`, "")
  if (plugin.tools.length > 0) {
    lines.push(
      `**Tools (${plugin.tools.length}):** ${plugin.tools.map((t) => t.name).join(", ")}`,
      "",
      `_Run \`/plugin tools ${plugin.id}\` to see each tool's schema._`
    )
  } else {
    lines.push("_This plugin declares no agent tools._")
  }
  return lines.join("\n")
}

export async function pluginShow(id: string, deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  const enabled = !disabledOf(deps).has(plugin.id)
  openDocument(deps.dispatch, {
    title: `Plugin · ${plugin.name}`,
    body: buildPluginDocument(plugin, enabled),
    format: "markdown",
  })
}

/** `/plugin tools <id>` — show each declared tool's description + schema. */
export async function pluginTools(id: string, deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  if (plugin.tools.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${plugin.name}" declares no agent tools.`,
    })
    return
  }
  openDocument(deps.dispatch, {
    title: `Tools · ${plugin.name} (${plugin.tools.length})`,
    body: buildToolsDocument(
      plugin.tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        schema: t.parametersSchema,
      })),
      `${plugin.tools.length} tool${plugin.tools.length === 1 ? "" : "s"} declared by \`${plugin.id}\`.`
    ),
    format: "markdown",
  })
}

// ── enable / disable (persist overlay + flip live manager) ──────────────────────

export async function pluginSetEnabled(
  id: string,
  enabled: boolean,
  deps: PluginDeps
): Promise<void> {
  ;(deps.setEnabled ?? ((i, d) => setPluginDisabled(deps.home, i, d)))(id, !enabled)
  try {
    const setLive =
      deps.setLive ??
      (async (pid: string, on: boolean) => {
        const host = await realHost()
        if (on) await host.enablePlugin(pid)
        else await host.disablePlugin(pid)
      })
    await setLive(id, enabled)
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${id}" ${enabled ? "enable" : "disable"} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Plugin "${id}" ${enabled ? "enabled" : "disabled"}.`,
  })
}

// ── reload ──────────────────────────────────────────────────────────────────────

export async function pluginReload(id: string, deps: PluginDeps): Promise<void> {
  if (!id) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin reload <id>" })
    return
  }
  try {
    const reload =
      deps.reload ??
      (async (pid: string) => {
        const { reloadPlugin } = await import("../../plugin/host")
        await reloadPlugin(pid, { manager: await realHost() })
      })
    await reload(id)
    deps.dispatch({ type: "NOTICE", message: `Plugin "${id}" reloaded.` })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Reload failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── install (consent summary → confirmed install) ───────────────────────────────

/** Build a markdown consent summary surfacing every grant before install. */
export function buildConsentSummary(
  manifest: PluginManifest,
  opts: { ref: string; alreadyInstalled: boolean }
): string {
  const declared = (manifest.permissions ?? []) as PluginPermission[]
  const optional = (manifest.optionalPermissions ?? []) as PluginPermission[]
  const net = manifest.networkAccess
  const lines: string[] = [
    `# Install ${manifest.name ?? manifest.id}?`,
    "",
    `\`${manifest.id}\` · v${manifest.version ?? "?"} · from \`${opts.ref}\``,
    "",
  ]
  if (manifest.type !== "frontend") {
    lines.push(
      `⚠️ Type \`${manifest.type}\` is **unsupported in CLI** (needs the desktop host).`,
      ""
    )
  }
  if (opts.alreadyInstalled) {
    lines.push(`⚠️ \`${manifest.id}\` is already installed — installing will overwrite it.`, "")
  }
  lines.push(
    "**Permissions requested:**",
    declared.length ? declared.map((p) => `- \`${p}\``).join("\n") : "- _none_",
    ""
  )
  if (optional.length) {
    lines.push("**Optional permissions:**", optional.map((p) => `- \`${p}\``).join("\n"), "")
  }
  if (net?.allowedDomains?.length) {
    lines.push(
      "**Network egress allowlist:**",
      net.allowedDomains.map((d) => `- \`${d}\``).join("\n"),
      ...(net.reasoning ? ["", `_${net.reasoning}_`] : []),
      ""
    )
  }
  lines.push("Press **Enter** to install, **Esc** to cancel.")
  return lines.join("\n")
}

/** Strip the internal `--confirmed` flag and return `{ ref, confirmed }`. */
export function parseInstallArg(arg: string): { ref: string; confirmed: boolean } {
  const confirmed = /(^|\s)--confirmed(\s|$)/.test(arg)
  const ref = arg.replace(/(^|\s)--confirmed(\s|$)/, " ").trim()
  return { ref, confirmed }
}

export async function pluginInstall(arg: string, deps: PluginDeps): Promise<void> {
  const { ref, confirmed } = parseInstallArg(arg)
  if (!ref) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin install <owner/repo[@ref][/subdir]>" })
    return
  }

  if (!confirmed) {
    // Phase 1 — fetch the manifest and show a single consent summary. Enter
    // re-runs this command with the internal --confirmed flag.
    try {
      const preview =
        deps.preview ??
        (async (r: string) => {
          const { parseGithubPluginRef, fetchGithubPluginPreview } =
            await import("@/lib/plugin/package/github-source")
          return fetchGithubPluginPreview(parseGithubPluginRef(r))
        })
      const isInstalled = deps.isInstalled ?? (() => false)
      const { manifest } = await preview(ref)
      deps.dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "confirm",
          title: `Install ${manifest.name ?? manifest.id}?`,
          body: buildConsentSummary(manifest, { ref, alreadyInstalled: isInstalled(manifest.id) }),
          format: "markdown",
          onConfirmCommand: `plugin install ${ref} --confirmed`,
        },
      })
    } catch (err) {
      deps.dispatch({
        type: "NOTICE",
        message: `Could not read plugin "${ref}": ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    return
  }

  // Phase 2 — user confirmed: download + register + enable.
  try {
    const install =
      deps.install ??
      (async (r: string) => {
        const { installFromGithubRef } = await import("../../plugin/install")
        const { registerDiskPlugins } = await import("../../plugin/host")
        const result = await installFromGithubRef(r, { home: deps.home })
        const host = await realHost()
        await registerDiskPlugins({
          manager: host,
          discover: async () => [
            { id: result.id, dir: result.dir, manifest: result.manifest, supported: true },
          ],
          disabled: disabledOf(deps),
          notify: (m) => deps.dispatch({ type: "NOTICE", message: m }),
        })
        return { id: result.id }
      })
    const { id } = await install(ref)
    deps.dispatch({ type: "NOTICE", message: `Installed "${id}".` })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── uninstall ─────────────────────────────────────────────────────────────────

export async function pluginUninstall(id: string, deps: PluginDeps): Promise<void> {
  if (!id) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin uninstall <id>" })
    return
  }
  try {
    const uninstall =
      deps.uninstall ??
      (async (pid: string) => {
        const { uninstallHostPlugin } = await import("../../plugin/host")
        const host = await realHost()
        const dir = host.pluginDir(pid)
        if (!dir) throw new Error(`unknown plugin: ${pid}`)
        await uninstallHostPlugin(pid, dir, { manager: host })
      })
    await uninstall(id)
    setPluginDisabled(deps.home, id, false) // clear any stale disabled entry
    deps.dispatch({ type: "NOTICE", message: `Uninstalled "${id}".` })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── marketplace sources ─────────────────────────────────────────────────────────

export function pluginSourcesList(deps: PluginDeps): void {
  const sources = (deps.getSources ?? (() => readSources(deps.home)))()
  deps.dispatch({
    type: "NOTICE",
    message: sources.length
      ? `Marketplace sources: ${sources.join(", ")}`
      : "No marketplace sources. Add one with /plugin sources add <owner/repo>.",
  })
}

export function pluginSourcesAdd(ref: string, deps: PluginDeps): void {
  if (!ref) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin sources add <owner/repo[@ref]>" })
    return
  }
  ;(deps.addSource ?? ((r) => void addSourceToStore(deps.home, r)))(ref)
  deps.dispatch({ type: "NOTICE", message: `Added marketplace source "${ref}".` })
}

export function pluginSourcesRemove(ref: string, deps: PluginDeps): void {
  if (!ref) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin sources remove <owner/repo[@ref]>" })
    return
  }
  ;(deps.removeSource ?? ((r) => void removeSourceFromStore(deps.home, r)))(ref)
  deps.dispatch({ type: "NOTICE", message: `Removed marketplace source "${ref}".` })
}

// ── marketplace browse ──────────────────────────────────────────────────────────

export async function pluginMarketplace(deps: PluginDeps): Promise<void> {
  const sources = (deps.getSources ?? (() => readSources(deps.home)))()
  if (sources.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No marketplace sources. Add one with /plugin sources add <owner/repo>.",
    })
    return
  }
  const browse =
    deps.browse ??
    (async (srcs: string[]) => {
      const { fetchAllSourceEntries } = await import("@/lib/plugin/package/github-marketplace")
      const { entries, errors } = await fetchAllSourceEntries(srcs)
      return {
        entries: entries.map((e) => {
          const g = e.github
          const ref = g.ref ? `@${g.ref}` : ""
          const sub = g.subdir ? `/${g.subdir}` : ""
          return {
            name: e.name,
            installRef: `${g.owner}/${g.repo}${ref}${sub}`,
            description: e.description,
          }
        }),
        errors,
      }
    })
  let result: {
    entries: Array<{ name: string; installRef: string; description?: string }>
    errors: Array<{ repoRef: string; message: string }>
  }
  try {
    result = await browse(sources)
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Marketplace fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    return
  }
  if (result.errors.length) {
    deps.dispatch({
      type: "NOTICE",
      message: `Some sources failed: ${result.errors.map((e) => e.repoRef).join(", ")}`,
    })
  }
  if (result.entries.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No plugins found in the configured sources." })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Marketplace (Enter installs)",
      items: result.entries.map((e) => ({
        id: e.installRef,
        label: e.name,
        hint: e.description ?? e.installRef,
      })),
      index: 0,
      onSelectCommand: "plugin install",
    },
  })
}
