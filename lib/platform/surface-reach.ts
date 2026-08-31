import type { CapabilityId, HostProfile } from "./capabilities"

/**
 * Can this surface run from here, and if not, why?
 *
 * The generalisation of `lib/connectors/control-reach.ts`, which solved the
 * same problem for the twenty connector controls that used to answer it with
 * `const desktop = isTauri()` and one of eleven near-identical strings. The
 * shape is deliberately the same: one resolver, so the day a capability
 * becomes reachable from a companion, every surface that needs it changes
 * behaviour by editing this file.
 *
 * `isTauri()` is the wrong question in both directions, and the repo has
 * roughly a thousand call sites making that mistake:
 *
 *  - It is **too narrow**. A phone or browser paired to a host reaches plenty
 *    of host-owned capabilities over the companion RPC. Telling that user to
 *    "open the desktop app" is false, and it hides a control that works.
 *  - It is **too broad**. Under Node, jsdom, or the headless brain there is no
 *    `window.__TAURI_INTERNALS__` either, so `!isTauri()` reads "I am a browser
 *    companion" in a process that is not a browser at all.
 *
 * The vocabulary here is the answer to "why not", because that is what the UI
 * has to say. Hiding a control collapses three different answers into one
 * silence: never existed here, one pairing away, and broken right now.
 */

/** What a surface needs before it can run. */
export type SurfaceRequirement =
  /** A host holding this capability, wherever that host is. */
  | "capability"
  /**
   * The desktop process ITSELF, not merely a host. Spawning a child process
   * the user can see, driving a native webview, reading the OS keychain
   * interactively. A headless host runs plenty of capabilities and can do none
   * of these.
   */
  | "desktop-shell"

/**
 * Why a surface cannot run here. Four genuinely different situations that
 * `isTauri() === false` used to collapse into one sentence.
 */
export type SurfaceBlock =
  /** No host at all: not this shell, and nothing paired. Pairing fixes it. */
  | "no-host"
  /** Needs the desktop process itself, which this shell is not. */
  | "needs-desktop-shell"
  /** There IS a host, and it does not offer this capability. */
  | "host-lacks-capability"
  /** This shell IS the host, and it cannot do this (wrong OS, arch, build). */
  | "local-lacks-capability"

export const SURFACE_BLOCKS: readonly SurfaceBlock[] = Object.freeze([
  "no-host",
  "needs-desktop-shell",
  "host-lacks-capability",
  "local-lacks-capability",
] as const)

export interface SurfaceReach {
  available: boolean
  block?: SurfaceBlock
  /**
   * Route that would fix it, when one exists. `null` for terminal causes: a
   * surface that needs the desktop process has nowhere to send a phone, and
   * padding that out with a link would make it look actionable.
   */
  remedy?: "/pair" | null
}

export interface SurfaceReachInput {
  profile: HostProfile
  /**
   * Does a host hold this capability? Local baseline OR the static
   * server-backed set (`capabilityAvailable` in `hooks/use-host-profile`) OR
   * the paired host's own feature manifest, whichever the caller can see.
   *
   * Passed in rather than resolved here so this stays a pure function, and so
   * the two ways to learn it (`activeHostSupportsFeature` when this shell is
   * driving another host, `RuntimeSnapshot.host.operations` when it is a
   * companion) both feed one resolver.
   */
  capabilityAvailable: boolean
  requirement?: SurfaceRequirement
  /** Only used to label the reach for tests and `data-` attributes. */
  capability?: CapabilityId
}

const AVAILABLE: SurfaceReach = Object.freeze({ available: true })

function blocked(block: SurfaceBlock, remedy: "/pair" | null = null): SurfaceReach {
  return { available: false, block, remedy }
}

/**
 * Resolve one surface against one host profile.
 *
 * Order matters. `web-standalone` is checked before the capability, because a
 * browser with nothing paired has no host to lack a capability: the true
 * answer is "there is nowhere for this to run", and the remedy is pairing, not
 * a different build.
 */
export function resolveSurfaceReach({
  profile,
  capabilityAvailable,
  requirement = "capability",
}: SurfaceReachInput): SurfaceReach {
  if (profile === "web-standalone") return blocked("no-host", "/pair")
  if (requirement === "desktop-shell") {
    // `headless` is not the desktop process either, and saying so is the point:
    // it runs the capability perfectly well and still has no window, no tray
    // and no interactive keychain.
    return profile === "desktop" ? AVAILABLE : blocked("needs-desktop-shell")
  }
  if (capabilityAvailable) return AVAILABLE
  // The distinction the UI needs: "this machine cannot" reads as a build or
  // platform limit the user might fix, while "the host you are paired to
  // cannot" points at a different machine entirely.
  return blocked(
    profile === "desktop" || profile === "headless"
      ? "local-lacks-capability"
      : "host-lacks-capability"
  )
}
