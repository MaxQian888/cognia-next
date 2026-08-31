/**
 * Can the connector *control* surfaces run from this host, and if not, why?
 *
 * Every control in `components/settings/connections/**` — test the token,
 * probe the bot identity, send a test message, reconnect, poll the inbound
 * server, start the tunnel — used to answer that with `const desktop =
 * isTauri()` and, when false, one of eleven near-identical strings saying
 * "requires the desktop runtime".
 *
 * The BEHAVIOUR was right and stays unchanged: those controls call
 * `connectors_*`, whose 42 manifest entries are all `target: service` with an
 * empty `transports` list, so a paired browser has no route to any of them
 * (raising that to the device plane is its own change, with its own consent
 * story). What was wrong is the EXPLANATION, and it was wrong in opposite
 * directions on the two non-desktop profiles:
 *
 * - **A cloud or mobile companion** is told adapters "require the desktop
 *   app" while its bots are running perfectly well on the paired host, and
 *   while the Inbox beside it is replying, approving drafts and writing
 *   overrides through the relay (`lib/connectors/inbox-writes/route.ts`).
 *   The true statement is narrower: these particular controls talk to the
 *   runtime process directly, and the browser has no route to that process.
 * - **A standalone browser** has no connector runtime anywhere — not here,
 *   not on a paired host, because there is no paired host. "Open the desktop
 *   app" is the right answer there, and it is the only profile where it is.
 *
 * Keeping one resolver means the day `connectors_*` becomes reachable from a
 * device, twenty controls change behaviour by editing this file.
 */

import type { HostProfile } from "@/lib/platform/capabilities"

/**
 * What a control needs.
 *
 * `desktop-shell` is for the handful that need a facility of the desktop
 * process itself rather than the connector runtime: the cloudflared child
 * process, personal-WeChat QR login, Matrix password login. A headless host
 * runs adapters happily and still cannot do any of those.
 */
export type ConnectorControlRequirement = "connector-runtime" | "desktop-shell"

/**
 * Why a control cannot run here. Three genuinely different situations that
 * `isTauri() === false` used to collapse into one sentence.
 */
export type ConnectorControlBlock =
  /** No connector runtime exists on this host or on any host it is paired to. */
  | "no-runtime"
  /** The runtime is on the paired host; this control cannot reach it from here. */
  | "runs-on-host"
  /** Needs the desktop process itself, which this host is not. */
  | "needs-desktop-shell"

/**
 * The union as a value, so a test can walk it.
 *
 * Nothing renders this list, and it looks like dead code because of that. It
 * is not: `ConnectorHostNotice` reads its message with `t(\`block.${block}\`)`,
 * a template-literal key that `pnpm lint:i18n` skips entirely. This constant
 * is what lets `control-reach.test.ts` prove every block has a reason and a
 * next step in both locales, and what makes adding a fourth block a failing
 * test rather than an untranslated string in production.
 */
export const CONNECTOR_CONTROL_BLOCKS: readonly ConnectorControlBlock[] = Object.freeze([
  "no-runtime",
  "runs-on-host",
  "needs-desktop-shell",
] as const)

export interface ConnectorControlReach {
  available: boolean
  block?: ConnectorControlBlock
}

const AVAILABLE: ConnectorControlReach = Object.freeze({ available: true })

function blocked(block: ConnectorControlBlock): ConnectorControlReach {
  return { available: false, block }
}

/**
 * Resolve one control against one host profile.
 *
 * `web-standalone` answers `no-runtime` for BOTH requirements: a browser with
 * no paired host has no bot to configure at all, and telling someone their
 * tunnel needs the desktop app skips the part where they have no adapter
 * either.
 */
export function connectorControlReach(
  profile: HostProfile,
  requirement: ConnectorControlRequirement = "connector-runtime"
): ConnectorControlReach {
  if (profile === "desktop") return AVAILABLE
  if (profile === "web-standalone") return blocked("no-runtime")
  if (requirement === "desktop-shell") return blocked("needs-desktop-shell")
  // `headless` never renders this UI — it has no webview — but it does own a
  // connector runtime, so answering anything else here would be a lie waiting
  // for the first server-rendered settings page.
  if (profile === "headless") return AVAILABLE
  return blocked("runs-on-host")
}
