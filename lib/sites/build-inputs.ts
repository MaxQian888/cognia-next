/**
 * The runtime, package manager, and network allowances a build runs with.
 *
 * These lived as `useState` literals inside the publish tab — `node@24`,
 * `pnpm@10`, `registry.npmjs.org` — which had three consequences. They reset on
 * every visit; they did *not* reset when the selected Site changed, so Site A's
 * inputs were used for Site B's build; and a typo like `node@42` reached the
 * sandbox unchallenged.
 *
 * Seeding precedence: the newest version's own snapshot, then what the manifest
 * implies, then the defaults. The first is what makes a rebuild repeat a build
 * rather than re-derive one.
 */
import type { SiteHostingManifest } from "./manifest"
import type { SitePackageManager } from "./manifest-scaffold"
import type { SiteVersionRow } from "@/types/sites"

export interface SiteBuildInputs {
  runtime: string
  packageManager: string
  /** Hosts the install phase may reach. Empty means no network. */
  installNetworkHosts: string[]
  /** Hosts the build phase may reach. Empty is the fail-closed default. */
  buildNetworkHosts: string[]
}

/** Known-good values the picker offers. A custom string is still accepted. */
export const SITE_BUILD_RUNTIMES = ["node@24", "node@22", "node@20"] as const
export const SITE_BUILD_PACKAGE_MANAGERS = [
  "pnpm@10",
  "pnpm@9",
  "npm@10",
  "yarn@4",
  "bun@1",
] as const

export const SITE_BUILD_INPUT_DEFAULTS: SiteBuildInputs = {
  runtime: "node@24",
  packageManager: "pnpm@10",
  // The registry the install phase needs, and nothing else. A corporate
  // registry has to be named explicitly, which is the fail-closed behaviour
  // ADR-0084 asks for even though it costs one manual entry.
  installNetworkHosts: ["registry.npmjs.org"],
  buildNetworkHosts: [],
}

/** Which package manager the manifest's install command implies, if any. */
export function packageManagerFromManifest(
  manifest: SiteHostingManifest | undefined
): SitePackageManager | undefined {
  const command = manifest?.build.install?.[0]
  if (command === "pnpm" || command === "npm" || command === "yarn" || command === "bun") {
    return command
  }
  return undefined
}

/** A fresh copy every time: the arrays are edited in place by the form. */
function cloneDefaults(): SiteBuildInputs {
  return {
    ...SITE_BUILD_INPUT_DEFAULTS,
    installNetworkHosts: [...SITE_BUILD_INPUT_DEFAULTS.installNetworkHosts],
    buildNetworkHosts: [...SITE_BUILD_INPUT_DEFAULTS.buildNetworkHosts],
  }
}

export type SiteBuildInputSource = "last-version" | "manifest" | "default"

/**
 * Seed the build form for one Site.
 *
 * @param versions that Site's versions; the newest completed one wins.
 */
export function seedSiteBuildInputs(
  versions: readonly SiteVersionRow[],
  manifest?: SiteHostingManifest
): { inputs: SiteBuildInputs; source: SiteBuildInputSource } {
  const newest = [...versions]
    .filter((version) => version.status !== "building")
    .sort((left, right) => right.sequence - left.sequence)[0]

  if (newest) {
    return {
      inputs: {
        runtime: newest.build.runtime,
        packageManager: newest.build.packageManager,
        // Absent on versions written before these were recorded; falling back
        // to the defaults is closer to that build than claiming "no network".
        installNetworkHosts: [
          ...(newest.build.installNetworkHosts ?? SITE_BUILD_INPUT_DEFAULTS.installNetworkHosts),
        ],
        buildNetworkHosts: [...(newest.build.buildNetworkHosts ?? [])],
      },
      source: "last-version",
    }
  }

  const implied = packageManagerFromManifest(manifest)
  if (implied) {
    const pinned = SITE_BUILD_PACKAGE_MANAGERS.find((value) => value.startsWith(`${implied}@`))
    return {
      inputs: { ...cloneDefaults(), packageManager: pinned ?? implied },
      source: "manifest",
    }
  }

  return { inputs: cloneDefaults(), source: "default" }
}
