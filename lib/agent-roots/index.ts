/**
 * Where Claude Code / Codex / OpenCode keep their config and data trees on
 * this host.
 *
 * Every importer in the app — sessions (`lib/session-import/`), MCP
 * (`lib/claude/agents/`), subagents (`lib/claude/subagent-importers/`),
 * skills, memory (`lib/memory/external/`), settings (`lib/settings-import/`)
 * and commands (`lib/commands-import/`) — needs the same answer, and each of
 * those trees is relocatable by an environment variable that the renderer
 * cannot read. So the resolution happens once in Rust
 * (`src-tauri/src/agents/paths.rs:vendor_roots`, exposed as
 * `agent_vendor_roots`) and is cached here.
 *
 * Before this module existed, `lib/session-import/adapters/codex.ts` claimed
 * in a comment to honour `$CODEX_HOME` while hard-coding `<home>/.codex`.
 *
 * The pure {@link vendorRootsFromHome} fallback keeps web mode, the CLI, and
 * unit tests working without the desktop IPC.
 */

import { joinPath, stripTrailingSep } from "@/lib/claude/instructions/paths"
import type { ExternalPlatform } from "@/lib/memory/external/types"
import { detectPlatform, resolveHome } from "@/lib/memory/external/home"

/**
 * Absolute per-vendor root directories. An empty string means "not resolvable
 * on this host" — callers must treat it as "this vendor cannot be scanned"
 * rather than joining onto `""` and walking from the filesystem root.
 *
 * Mirrors `src-tauri/src/agents/paths.rs:VendorRoots` field for field.
 */
export interface VendorRoots {
  /** `$CLAUDE_CONFIG_DIR` or `<home>/.claude`. */
  claudeConfigDir: string
  /** `$CODEX_HOME` or `<home>/.codex`. */
  codexHome: string
  /** `$XDG_CONFIG_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.config/opencode`. */
  opencodeConfigDir: string
  /** `$XDG_DATA_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.local/share/opencode`. */
  opencodeDataDir: string
  /** Platform data fallback retained alongside XDG (e.g. redirected `%APPDATA%`). */
  opencodePlatformDataDir?: string
}

/** All roots unresolvable — what web mode gets, and the shape of a failed IPC. */
export const EMPTY_VENDOR_ROOTS: VendorRoots = {
  claudeConfigDir: "",
  codexHome: "",
  opencodeConfigDir: "",
  opencodeDataDir: "",
  opencodePlatformDataDir: "",
}

/** True when at least one vendor tree is locatable. */
export function hasAnyVendorRoot(roots: VendorRoots): boolean {
  return Object.values(roots).some((v) => v.length > 0)
}

/**
 * The environment variables that relocate a vendor tree. Named exactly as the
 * vendors document them so a reader can grep either way.
 */
export interface VendorRootEnv {
  CLAUDE_CONFIG_DIR?: string
  CODEX_HOME?: string
  XDG_CONFIG_HOME?: string
  XDG_DATA_HOME?: string
  /** Windows roaming app data; only consulted when `platform === "windows"`. */
  APPDATA?: string
}

/** A non-blank env value, trimmed — mirrors `paths.rs:env_path`. */
function envDir(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? stripTrailingSep(trimmed) : null
}

/**
 * Pure resolution of the vendor roots from a home dir + an environment.
 * MUST stay in sync with `src-tauri/src/agents/paths.rs:vendor_roots_from`,
 * which is what the desktop actually uses; this implementation serves the
 * standalone CLI (which passes `process.env`), web mode, and tests.
 */
export function vendorRootsFromEnv(
  home: string | undefined,
  env: VendorRootEnv = {},
  platform: ExternalPlatform = "linux"
): VendorRoots {
  const base = home ? stripTrailingSep(home) : ""
  const xdgConfig = envDir(env.XDG_CONFIG_HOME)
  const xdgData = envDir(env.XDG_DATA_HOME)
  // Windows has no XDG default; both OpenCode and this repo
  // (src-tauri/src/fleet/opencode.rs) fall back to %APPDATA%.
  const appData =
    platform === "windows"
      ? (envDir(env.APPDATA) ?? (base ? joinPath(base, "AppData/Roaming") : null))
      : null
  const under = (dir: string | null, rel: string): string =>
    dir ? joinPath(dir, "opencode") : base ? joinPath(base, rel) : ""
  const platformData =
    platform === "windows"
      ? appData
      : platform === "macos" && base
        ? joinPath(base, "Library/Application Support")
        : (xdgData ?? (base ? joinPath(base, ".local/share") : null))

  return {
    claudeConfigDir: envDir(env.CLAUDE_CONFIG_DIR) ?? (base ? joinPath(base, ".claude") : ""),
    codexHome: envDir(env.CODEX_HOME) ?? (base ? joinPath(base, ".codex") : ""),
    opencodeConfigDir: under(xdgConfig ?? appData, ".config/opencode"),
    opencodeDataDir: under(xdgData ?? appData, ".local/share/opencode"),
    opencodePlatformDataDir: under(platformData, ".local/share/opencode"),
  }
}

/**
 * Environment-free fallback: derive the roots from a home directory alone.
 * Cannot see `$CODEX_HOME` and friends — only the Rust resolver (or the CLI
 * via {@link vendorRootsFromEnv}) can, which is why {@link resolveVendorRoots}
 * prefers the IPC answer.
 */
export function vendorRootsFromHome(
  home: string | undefined,
  platform: ExternalPlatform = "linux",
  appData?: string
): VendorRoots {
  return vendorRootsFromEnv(home, { APPDATA: appData }, platform)
}

/** Narrow an untrusted IPC payload to {@link VendorRoots}. */
function asVendorRoots(value: unknown): VendorRoots | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const read = (key: keyof VendorRoots): string =>
    typeof v[key] === "string" ? stripTrailingSep(v[key] as string) : ""
  const roots: VendorRoots = {
    claudeConfigDir: read("claudeConfigDir"),
    codexHome: read("codexHome"),
    opencodeConfigDir: read("opencodeConfigDir"),
    opencodeDataDir: read("opencodeDataDir"),
  }
  const platformDataDir = read("opencodePlatformDataDir")
  if (platformDataDir) roots.opencodePlatformDataDir = platformDataDir
  return hasAnyVendorRoot(roots) ? roots : null
}

export interface ResolveVendorRootsDeps {
  /** Override the IPC call (tests / CLI). */
  call?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  /** Override home resolution (tests / web). */
  homeDir?: () => Promise<string | null>
  /** Override OS-family detection (tests). */
  platform?: ExternalPlatform
}

let cached: Promise<VendorRoots> | null = null

async function resolveUncached(deps: ResolveVendorRootsDeps): Promise<VendorRoots> {
  // Desktop: the only place that can see the environment variables.
  try {
    const call =
      deps.call ??
      (async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        const { transport } = await import("@/lib/tauri")
        return transport.call<T>(command, args)
      })
    const roots = asVendorRoots(await call<unknown>("agent_vendor_roots"))
    if (roots) return roots
  } catch {
    // Not on desktop, or the command isn't available — fall through.
  }
  const home = await (deps.homeDir ? deps.homeDir() : resolveHome())
  if (!home) return { ...EMPTY_VENDOR_ROOTS }
  return vendorRootsFromHome(home, deps.platform ?? detectPlatform())
}

/**
 * Resolve (and cache) the vendor roots. The answer only changes when the
 * process' environment changes, so it is memoized for the app's lifetime; a
 * failed resolution is NOT cached so a later call can retry.
 */
export async function resolveVendorRoots(deps: ResolveVendorRootsDeps = {}): Promise<VendorRoots> {
  // Explicit deps mean "don't touch (or poison) the shared cache".
  if (deps.call || deps.homeDir || deps.platform) return resolveUncached(deps)
  if (!cached) {
    cached = resolveUncached(deps).then((roots) => {
      if (!hasAnyVendorRoot(roots)) cached = null
      return roots
    })
  }
  return cached
}

/** Drop the memoized roots. Tests only. */
export function __resetVendorRootsCacheForTesting(): void {
  cached = null
}
