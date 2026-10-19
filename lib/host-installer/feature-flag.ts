/**
 * Whether this build offers installing a Cognia Host on a machine
 * (ADR-0235 P5): the "Install a Cognia Host" action on a saved SSH host and
 * the "This machine" controls of a Host installed that way.
 *
 * DORMANT BY DEFAULT until the real-machine smoke passes (install, pair, a
 * chat turn over the relay, uninstall). It is on when
 * `NEXT_PUBLIC_COGNIA_HOST_INSTALLER` is `1`/`true`/`on`, and in `next dev`
 * unless that variable says `0`/`false`/`off`. With the flag off nothing
 * opens a bootstrap session: the SSH host card says the installer is "not in
 * this build" in place of the action (`SshHostInstallEntry`), and
 * `feature-flag.test.ts` and that entry's test pin it. The native commands
 * stay registered; only this UI reaches them.
 */

export interface HostInstallerFlagEnv {
  flag?: string
  nodeEnv?: string
}

/** Next inlines only literal `process.env.NEXT_PUBLIC_*` reads into the static export. */
function buildEnv(): HostInstallerFlagEnv {
  return { flag: process.env.NEXT_PUBLIC_COGNIA_HOST_INSTALLER, nodeEnv: process.env.NODE_ENV }
}

export function hostInstallerEnabled(env: HostInstallerFlagEnv = buildEnv()): boolean {
  const flag = env.flag?.trim().toLowerCase()
  if (flag === "1" || flag === "true" || flag === "on") return true
  if (flag === "0" || flag === "false" || flag === "off") return false
  return env.nodeEnv === "development"
}
