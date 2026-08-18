/**
 * The one place that knows how to open the Agent Packages section pointed at a
 * particular package.
 *
 * Kept out of the providers and the settings pane so the URL shape lives in a
 * single testable function: ⌘K's `install` action, the external-agent settings
 * entry point and the section's own param reader all go through here, and a
 * change to the query vocabulary cannot leave one of them behind.
 */

/** The `/plugins` section id this subsystem owns. */
export const PI_PACKAGES_SECTION = "agent-packages"

/** Query param carrying a spec to pre-select for install. */
export const PI_INSTALL_PARAM = "piInstall"

/** Deep link to the section with `spec` staged in the pre-install dialog. */
export function piPackageInstallHref(spec: string): string {
  return `/plugins?section=${PI_PACKAGES_SECTION}&${PI_INSTALL_PARAM}=${encodeURIComponent(spec)}`
}

/** Deep link to the section with nothing pre-selected. */
export function piPackagesHref(): string {
  return `/plugins?section=${PI_PACKAGES_SECTION}`
}

/**
 * Read a staged spec back out of the section's search params.
 *
 * Returns null for an absent or blank value rather than an empty string, so a
 * caller can use a plain null check and never open a dialog for `""`.
 */
export function readPiInstallParam(
  params: {
    get: (key: string) => string | null
  } | null
): string | null {
  const raw = params?.get(PI_INSTALL_PARAM)?.trim()
  return raw ? raw : null
}
