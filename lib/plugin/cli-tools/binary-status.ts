/**
 * Live status of a plugin's declared external binaries
 * (`manifest.requires.binaries`), powering the degraded badge + install
 * hint in the Capabilities tab. Enable is NON-blocking on missing
 * binaries: the plugin still enables, the affected cliTools throw a
 * structured "binary missing" error at call time, and the UI surfaces the
 * documentation deep-link.
 */

import { detectCli, satisfiesMinVersion } from "@/lib/cli-bridge/detect-cli"
import type { PluginBinaryRequirement, PluginManifest } from "@/types/plugin"

export interface PluginBinaryStatus {
  name: string
  available: boolean
  version: string | null
  path: string | null
  /** False when present but below the declared minVersion. */
  satisfiesMin: boolean
  minVersion?: string
  documentation?: string
}

/** Probe every declared binary (detect_binary is TTL-cached native-side). */
export async function getPluginBinaryStatuses(
  manifest: Pick<PluginManifest, "requires">
): Promise<PluginBinaryStatus[]> {
  const declared: PluginBinaryRequirement[] = Array.isArray(manifest.requires?.binaries)
    ? manifest.requires.binaries
    : []
  return Promise.all(
    declared.map(async (req) => {
      const probe = await detectCli(req.name)
      return {
        name: req.name,
        available: probe.available,
        version: probe.version,
        path: probe.path,
        satisfiesMin: probe.available && satisfiesMinVersion(probe.version, req.minVersion),
        minVersion: req.minVersion,
        documentation: req.documentation,
      }
    })
  )
}
