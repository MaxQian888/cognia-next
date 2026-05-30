/**
 * Central, framework-agnostic app identity + build/runtime facts used by the
 * About page (`components/settings/about/*`).
 *
 * User-facing copy (taglines, labels) lives in i18n, NOT here — this module
 * only holds non-translated facts (name, copyright holder, version/build
 * identifiers) and the small helpers that read them from the platform.
 *
 * Reuses `APP_VERSION` (lib/app-version.ts) and the platform guards
 * (lib/tauri.ts). Build metadata is injected at build time via
 * `next.config.ts` → `process.env.NEXT_PUBLIC_GIT_COMMIT` / `_BUILD_TIME`.
 */

import { version as reactVersion } from "react"

import { APP_VERSION } from "@/lib/app-version"
import { isCapacitor, isTauri } from "@/lib/tauri"

export { APP_VERSION }

/** Product name. Mirrors `src-tauri/tauri.conf.json` `productName`. */
export const APP_NAME = "Cognia"

/** Copyright holder + the year the project started (for the legal line). */
export const COPYRIGHT_HOLDER = "AstroAir"
export const COPYRIGHT_START_YEAR = 2025

/**
 * Displayed licence label. The repository has no root `LICENSE` file and
 * `package.json` declares no `license` field, so this is intentionally `null`
 * until a licence is chosen — the legal card then shows only the
 * "View licence" repo link rather than fabricating a name.
 */
export const LICENSE_NAME: string | null = null

export type ReleaseChannel = "stable" | "rc" | "beta" | "alpha" | "dev"

/**
 * Derive the release channel from the semver prerelease tag of a version.
 * `1.2.3` → stable, `1.2.3-beta.1` → beta, `0.0.0` → dev.
 */
export function getReleaseChannel(version: string = APP_VERSION): ReleaseChannel {
  if (version === "0.0.0") return "dev"
  const pre = version.split("-")[1]?.toLowerCase() ?? ""
  if (pre.startsWith("rc")) return "rc"
  if (pre.startsWith("beta")) return "beta"
  if (pre.startsWith("alpha")) return "alpha"
  return "stable"
}

export interface BuildInfo {
  /** Short git commit hash, or `""` when built without git (tarball/CI). */
  commit: string
  /** ISO-8601 build timestamp, or `""` when not injected. */
  buildTime: string
}

/** Build-time identifiers injected by `next.config.ts`. */
export function getBuildInfo(): BuildInfo {
  return {
    commit: process.env.NEXT_PUBLIC_GIT_COMMIT ?? "",
    buildTime: process.env.NEXT_PUBLIC_BUILD_TIME ?? "",
  }
}

export interface RuntimeVersions {
  /** Tauri core version (desktop only), else `null`. */
  tauri: string | null
  /** React runtime version. */
  react: string
  /** Web engine + version parsed from the user agent, else `null`. */
  engine: string | null
}

/** Parse the rendering engine + version from a user-agent string. */
export function parseEngine(userAgent: string | undefined): string | null {
  if (!userAgent) return null
  const chromium = userAgent.match(/Chrome\/(\d+(?:\.\d+)*)/)
  if (chromium) return `Chromium ${chromium[1]}`
  const webkit = userAgent.match(/AppleWebKit\/(\d+(?:\.\d+)*)/)
  if (webkit) return `WebKit ${webkit[1]}`
  return null
}

/** Collect the runtime versions shown in the version/build card. */
export async function getRuntimeVersions(): Promise<RuntimeVersions> {
  let tauri: string | null = null
  if (isTauri()) {
    try {
      const { getTauriVersion } = await import("@tauri-apps/api/app")
      tauri = await getTauriVersion()
    } catch {
      tauri = null
    }
  }
  const engine = typeof navigator !== "undefined" ? parseEngine(navigator.userAgent) : null
  return { tauri, react: reactVersion, engine }
}

/**
 * Resolve the display app name — the Tauri runtime name when available,
 * else the static {@link APP_NAME}.
 */
export async function getAppName(): Promise<string> {
  if (isTauri()) {
    try {
      const { getName } = await import("@tauri-apps/api/app")
      return await getName()
    } catch {
      return APP_NAME
    }
  }
  return APP_NAME
}

interface CapacitorAppShape {
  getInfo(): Promise<{ name: string; version: string; build: string; id: string }>
}

/**
 * Native build number from `@capacitor/app` (Capacitor shell only). Returns
 * `null` on web/Tauri or when the plugin is unavailable. Mirrors the loader
 * used by `components/mobile/me/version-row.tsx`.
 */
export async function getNativeBuildNumber(
  loader?: () => Promise<string | null>
): Promise<string | null> {
  if (loader) return loader()
  if (!isCapacitor()) return null
  try {
    const moduleId = "@capacitor/app"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      App: CapacitorAppShape
    }
    const info = await mod.App.getInfo()
    return info.build
  } catch {
    return null
  }
}
