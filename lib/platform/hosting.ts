/**
 * Is this machine actually hosting the account's always-on work right now?
 * (ADR-0224 A3)
 *
 * Beside the static `always-on` capability on purpose, because that answer is
 * not this one. `always-on` says the shell CAN keep long-lived runners (every
 * desktop reports it, including one that is driving a remote host and runs
 * nothing of its own). Hosting adds the two facts the capability cannot know:
 *
 *  - the user turned on host mode, so the machine is held awake, launches
 *    hidden at login and closes to the tray instead of quitting; and
 *  - this shell is not driving another host, whose runners would be the ones
 *    doing the work.
 *
 * The headless server is always a host and has no mode switch; it is never
 * asked this, since it has no renderer.
 */

export interface HostingInput {
  /** The desktop's persisted host mode (`lib/tauri/host-mode.ts`). */
  hostMode: boolean
  /** The static `always-on` capability of this shell. */
  hasAlwaysOn: boolean
  /** Whether this shell is routing to a remote host. */
  remoteActive: boolean
}

export type HostingState =
  /** Host mode is on and this shell runs the account's always-on work. */
  | "hosting"
  /** Host mode is on, but this shell is driving another host right now. */
  | "standing-by"
  /** Host mode is off: work runs here only while the app is open. */
  | "off"
  /** This shell has no long-lived runners at all (browser, phone). */
  | "unsupported"

export function resolveHostingState(input: HostingInput): HostingState {
  if (!input.hasAlwaysOn) return "unsupported"
  if (!input.hostMode) return "off"
  return input.remoteActive ? "standing-by" : "hosting"
}

export function isHostingHere(input: HostingInput): boolean {
  return resolveHostingState(input) === "hosting"
}
