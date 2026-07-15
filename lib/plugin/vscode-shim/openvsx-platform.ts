/**
 * Open VSX `targetPlatform` resolution.
 *
 * Extensions may ship platform-specific builds (rust-analyzer bundles a native
 * `rust-analyzer` binary per platform). Open VSX models this with a 12-value
 * `targetPlatform` enum; the download URL embeds the platform segment.
 *
 * ## Why this refuses instead of guessing
 *
 * The tempting shortcut is "no `win32-arm64` build? install `win32-x64`, it'll
 * run under emulation". It won't — or rather, the *extension* will, and then
 * the native LSP binary it bundles dies at `spawn`, minutes-to-days after the
 * install, with an error that points at cognia rather than at the mismatch.
 * The failure is silent, delayed, and misattributed. So: exact platform ->
 * `universal` -> **named error**. Never a substitution.
 *
 * A platform miss from the registry is **`totalSize: 0`, not an HTTP error**
 * (verified: rust-analyzer with `targetPlatform=alpine-arm64` returns an empty
 * list; `darwin-arm64` and `universal` each return one). That is precisely why
 * the `universal` retry is *required* — an empty result is indistinguishable
 * from "extension doesn't exist" unless you retry.
 *
 * ## Known limitation: musl vs glibc
 *
 * `@tauri-apps/plugin-os` reports `platform()` / `arch()`, which cannot
 * distinguish an Alpine (musl) host from a glibc one — the distinction is a
 * libc fact, not an OS/arch fact. So an Alpine x64 machine maps to `linux-x64`
 * and, when no such build exists, falls back to `universal`. An extension that
 * publishes only `alpine-x64` will therefore be reported as unavailable on
 * Alpine. This is accepted, not solved: detecting musl needs a native probe
 * that the OS plugin does not expose, and Alpine desktop hosts are far outside
 * the target audience. Documented here so the next reader doesn't rediscover it
 * as a bug.
 */

import { getOsInfo } from "@/lib/tauri/os"

/** The 12 values Open VSX accepts. Verified against the live API. */
export const OPEN_VSX_TARGET_PLATFORMS = [
  "win32-x64",
  "win32-ia32",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "linux-armhf",
  "alpine-x64",
  "alpine-arm64",
  "darwin-x64",
  "darwin-arm64",
  "web",
  "universal",
] as const

export type OpenVsxTargetPlatform = (typeof OPEN_VSX_TARGET_PLATFORMS)[number]

/** The platform that works everywhere; the only legitimate fallback. */
export const UNIVERSAL_PLATFORM: OpenVsxTargetPlatform = "universal"

export type OpenVsxPlatformErrorReason =
  /** This machine has no Open VSX platform (e.g. running outside Tauri). */
  | "unsupported_host"
  /** Neither an exact-platform nor a `universal` build exists. */
  | "no_matching_build"
  /** A build exists for this platform but the registry says it isn't downloadable. */
  | "not_downloadable"

/** Named failure — every rejection path lands here rather than in a guess. */
export class OpenVsxPlatformError extends Error {
  constructor(
    readonly reason: OpenVsxPlatformErrorReason,
    message: string
  ) {
    super(message)
    this.name = "OpenVsxPlatformError"
  }
}

/** The subset of a query entry that platform selection needs. */
export interface PlatformCandidate {
  targetPlatform?: string
  downloadable?: boolean
}

/**
 * Map a `platform()` / `arch()` pair to the Open VSX enum.
 *
 * `arch` values come from `@tauri-apps/plugin-os`: `x86 | x86_64 | arm |
 * aarch64 | mips | ...`. Only the four that Open VSX has builds for are mapped;
 * anything else is an unsupported host rather than a coerced guess.
 */
export function mapHostToTargetPlatform(
  platform: string,
  arch: string
): OpenVsxTargetPlatform | null {
  const os =
    platform === "windows"
      ? "win32"
      : platform === "macos"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null
  if (!os) return null

  switch (arch) {
    case "x86_64":
      return `${os}-x64` as OpenVsxTargetPlatform
    case "aarch64":
      return `${os}-arm64` as OpenVsxTargetPlatform
    case "x86":
      // Open VSX only has a 32-bit x86 target for Windows.
      return os === "win32" ? "win32-ia32" : null
    case "arm":
      // ...and only a 32-bit ARM target for Linux.
      return os === "linux" ? "linux-armhf" : null
    default:
      return null
  }
}

/**
 * Resolve the current machine's target platform.
 *
 * @throws {OpenVsxPlatformError} `unsupported_host` outside Tauri (browser mode
 * can't install extensions anyway) or on an OS/arch combination Open VSX has no
 * enum value for.
 */
export async function resolveTargetPlatform(): Promise<OpenVsxTargetPlatform> {
  const info = await getOsInfo()
  if (!info) {
    throw new OpenVsxPlatformError(
      "unsupported_host",
      "Cannot determine the host platform — installing VS Code extensions requires the Cognia desktop app"
    )
  }

  const resolved = mapHostToTargetPlatform(info.platform, info.arch)
  if (!resolved) {
    throw new OpenVsxPlatformError(
      "unsupported_host",
      `No Open VSX build target matches this machine (${info.platform}/${info.arch})`
    )
  }
  return resolved
}

/**
 * Pick the build to install for `host` from one version's candidates.
 *
 * Order: exact platform -> `universal` -> named error. Non-downloadable
 * candidates are removed first, so a `downloadable: false` exact build can
 * still fall back to a `universal` one (which runs everywhere, so it is not a
 * guess) — but if nothing remains and the only exact match was undownloadable,
 * the error says *that* rather than the misleading "no build for your
 * platform".
 *
 * @throws {OpenVsxPlatformError}
 */
export function selectPlatformBuild<T extends PlatformCandidate>(
  candidates: readonly T[],
  host: OpenVsxTargetPlatform
): T {
  // `downloadable` is only present on `/query` responses; absent means the
  // registry made no claim, which we read as downloadable (search-sourced
  // entries would otherwise all be rejected).
  const downloadable = candidates.filter((c) => c.downloadable !== false)

  const exact = downloadable.find((c) => c.targetPlatform === host)
  if (exact) return exact

  const universal = downloadable.find(
    (c) => c.targetPlatform === UNIVERSAL_PLATFORM || c.targetPlatform === undefined
  )
  if (universal) return universal

  const blockedExact = candidates.some((c) => c.targetPlatform === host && c.downloadable === false)
  if (blockedExact) {
    throw new OpenVsxPlatformError(
      "not_downloadable",
      `The ${host} build of this extension is published but marked not downloadable by Open VSX, and no universal build is available`
    )
  }

  const offered = candidates
    .map((c) => c.targetPlatform ?? UNIVERSAL_PLATFORM)
    .filter((value, index, all) => all.indexOf(value) === index)
  throw new OpenVsxPlatformError(
    "no_matching_build",
    offered.length > 0
      ? `This extension has no build for ${host} and no universal build (available: ${offered.join(", ")}). Installing a different platform's build would fail later at launch, so it is refused.`
      : `This extension has no build for ${host}`
  )
}
