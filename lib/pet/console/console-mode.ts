// Which /pet console this device can show (ADR-0219).
//
// ADR-0058 D9 keeps the pet RUNTIME on the desktop: the controller, the
// overlay, the tray and the agent's pet tools never run anywhere else. The
// CONSOLE is different since ADR-0219: a paired phone or browser can operate
// the desktop's pet remotely, reading a mirror of its tables and sending every
// action to the desktop's controller, so XP is awarded exactly once.
//
//   local        the desktop app's main window, driving its own pet.
//   remote       a companion paired to a host that advertises `pet.remote-care`
//                (or a desktop driving such a host): the console reads the
//                mirror and every action is a `pet_*` RPC.
//   unavailable  nothing here can care for a pet, and the reason says which
//                remedy applies.
//
// Pure: the caller supplies the facts (`hooks/pet/use-pet-console-mode.ts`).

import type { PetAvailability } from "@/lib/pet/access/availability"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import type { PetConsoleMode } from "./action-capabilities"

/** The operation a host must advertise before a companion offers the console. */
export const PET_REMOTE_CARE_OPERATION = "pet_get"

export type PetConsoleUnavailableReason =
  /** No desktop is paired with this device. Remedy: `/pair`. */
  | "unpaired"
  /** Paired, but the host does not advertise remote pet care (an older or
   *  headless host). Remedy: update or open the desktop app. */
  | "host-without-feature"
  /** Paired, and the host's feature manifest has not arrived yet. */
  | "host-pending"
  /** A secondary desktop window (the overlay, the popup); the console belongs
   *  to the main window. */
  | "secondary-window"

export type PetConsoleModeResolution =
  { mode: PetConsoleMode } | { mode: "unavailable"; reason: PetConsoleUnavailableReason }

/**
 * Whether the paired host advertises remote pet care. Only a compatible host
 * whose manifest lists the snapshot read counts: an older desktop answers the
 * `pet_*` arms `unknown command`, and a headless brain answers `headless-host`
 * (it never advertises the feature at all).
 */
export function hostAdvertisesPetRemoteCare(snapshot: RuntimeSnapshot): boolean {
  return (
    snapshot.target?.kind === "companion" &&
    snapshot.host?.compatible === true &&
    snapshot.host.operations.includes(PET_REMOTE_CARE_OPERATION)
  )
}

export interface PetConsoleModeInput {
  /** `resolvePetAvailability` for this window, with `enabled: true`. */
  localAvailability: PetAvailability
  /** `isPetMirrorShell()`: this shell's pet tables are a companion mirror. */
  mirror: boolean
  snapshot: RuntimeSnapshot
  /**
   * A desktop driving a remote host has no runtime target (it is a host
   * itself), so the snapshot cannot say what that host advertises; the
   * remote-host store's manifest can.
   */
  activeRemoteHostSupportsPet: boolean
}

export function resolvePetConsoleMode(input: PetConsoleModeInput): PetConsoleModeResolution {
  if (!input.mirror && input.localAvailability.available) return { mode: "local" }
  if (input.activeRemoteHostSupportsPet || hostAdvertisesPetRemoteCare(input.snapshot)) {
    return { mode: "remote" }
  }
  if (input.snapshot.target?.kind === "companion") {
    return {
      mode: "unavailable",
      reason: input.snapshot.host ? "host-without-feature" : "host-pending",
    }
  }
  if (
    !input.mirror &&
    !input.localAvailability.available &&
    input.localAvailability.reason === "secondary-window"
  ) {
    return { mode: "unavailable", reason: "secondary-window" }
  }
  // A desktop whose remote host lacks the feature lands here too: its tables
  // are that host's mirror, so the local pet is not what the console would
  // show, and the host is what needs updating.
  if (input.mirror && input.localAvailability.available) {
    return { mode: "unavailable", reason: "host-without-feature" }
  }
  return { mode: "unavailable", reason: "unpaired" }
}
