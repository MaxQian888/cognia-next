/**
 * The grant → SecurityStore capability mapping, mirrored on the client.
 *
 * `src-tauri/src/companion_api/device_grants.rs` owns the canonical table and
 * says so: it is "the only place the mapping exists". This module is a read
 * mirror, and it exists for one reason — `companion_list_device_grants`
 * answers each grant with an **all-of** test, so a device holding `agent.run`
 * but not `workspace.write` came back as plain `false` and the old card drew
 * it identically to a device that had never been granted anything.
 *
 * `companion_list_devices` already returns the raw capability set, so the
 * partial state can be derived here without widening the Rust surface. The
 * mirror is pinned against the generated host command catalog by the
 * co-located test, so a renamed capability fails a gate instead of silently
 * downgrading every device to `partial`.
 */

import type { DeviceGrantId, DeviceGrantRow, DeviceGrantState } from "./types"

/**
 * Mirrors `GrantKind::capabilities()`. Order matches the Rust arrays so the
 * two read as the same table side by side.
 *
 * `device.admin` and `server.admin` are absent on purpose, and their absence
 * is the UI half of a documented dormancy (CLAUDE.md working rule 7). The
 * store will accept either as a grant, but neither is the required capability
 * of any command in `protocol/companion-commands.json`, so a switch here would
 * be a security control that controls nothing. The type-level note lives in
 * `security_store.rs::default_capabilities_for_role`, and
 * `every_grantable_capability_has_an_enforcement_point` fails if a command
 * ever starts requiring one, which is when a row belongs here.
 */
export const GRANT_CAPABILITIES: Readonly<Record<DeviceGrantId, readonly string[]>> = Object.freeze(
  {
    control: Object.freeze([
      "agent.run",
      "workspace.read",
      "workspace.write",
      "git.write",
      "workflow.run",
    ]),
    agentControl: Object.freeze(["process.spawn"]),
    terminal: Object.freeze(["terminal.open"]),
    /**
     * Locked Use is not a `GrantKind`: it is a separate allow list
     * (`locked_use_allow_list.rs`) with no SecurityStore capability behind it,
     * so there is nothing to intersect and the state comes from the mirror bit
     * alone.
     */
    lockedComputerUse: Object.freeze([]),
  }
)

export const DEVICE_GRANT_IDS: readonly DeviceGrantId[] = Object.freeze([
  "control",
  "agentControl",
  "terminal",
  "lockedComputerUse",
])

/**
 * Whether Locked Use can be granted at all on this build.
 *
 * `false` because the grant has no enforcement point yet: the policy core
 * (`LockedUseController`) is complete, but the macOS edges it sits behind —
 * the XPC service, the guardian windows, the Authorization Plugin — have not
 * shipped, so nothing ever consumes the grant.
 *
 * This is the type axis of the dormancy contract in CLAUDE.md working rule 7;
 * the UI axis is the labelled inert switch in the Access tab and the test axis
 * is `grant-capabilities.test.ts`. Flipping it to `true` is one of three edits
 * that must land together — see
 * `src-tauri/src/companion_api/locked_use_allow_list.rs`, whose module docs
 * and dormancy test name the other two.
 */
export const LOCKED_USE_AVAILABLE = false

export interface GrantEvidence {
  /**
   * Raw SecurityStore capabilities the host says this device holds. `undefined`
   * when the host could not be asked — off-Tauri, or the call failed.
   */
  hostCapabilities?: readonly string[]
  /**
   * The host's all-of verdict per grant, from `companion_list_device_grants`.
   * Used when {@link hostCapabilities} is unavailable.
   */
  hostVerdict?: { control: boolean; agentControl: boolean; terminal: boolean }
  /** The Dexie mirror bits. The last fallback, and never authoritative. */
  mirror: {
    control: boolean
    agentControl: boolean
    terminal: boolean
    lockedComputerUse: boolean
  }
  /** A revoked device holds nothing, whatever any table still says. */
  revoked: boolean
  /**
   * The host refuses this device's grants because it belongs to somebody else
   * — ADR-0149 §5 step two. Derived by {@link ownerPermits}; nothing here
   * decides it, because the decision is the host's and this is a mirror.
   */
  ownerSuspended?: boolean
}

/**
 * The client twin of `OWNER_PREDICATE_SQL` in
 * `src-tauri/src/companion_api/security_store.rs`.
 *
 * The host is the authority — it re-evaluates this per request in SQL — and
 * this copy exists only so the console can SAY why a switch that looks on is
 * not being honoured. A co-located test reads the Rust file and fails if the
 * two ever disagree, because a mirror that drifts is worse than no mirror: it
 * would draw a grant as live that the host has been refusing for weeks.
 *
 * Both `undefined`s pass, for the reasons the Rust doc gives: nobody signed in
 * is a supported state, and an unattributed device is every device that
 * existed before the column did.
 */
export function ownerPermits(hostPerson?: string, devicePerson?: string): boolean {
  if (!hostPerson || !devicePerson) return true
  return hostPerson === devicePerson
}

function stateFromCapabilities(
  required: readonly string[],
  held: ReadonlySet<string>
): DeviceGrantState {
  if (required.length === 0) return "denied"
  const hits = required.filter((capability) => held.has(capability))
  if (hits.length === required.length) return "granted"
  return hits.length === 0 ? "denied" : "partial"
}

/**
 * Project one device's grant evidence into four rows.
 *
 * Precedence is the same one the old card used for its switches — the host's
 * answer when we have it, the Dexie mirror only as a fallback for shells that
 * cannot reach the host — extended so that the *raw* capability set, when
 * present, outranks the host's collapsed boolean.
 */
export function buildGrantRows(evidence: GrantEvidence): DeviceGrantRow[] {
  const held = evidence.hostCapabilities ? new Set(evidence.hostCapabilities) : null

  return DEVICE_GRANT_IDS.map((id): DeviceGrantRow => {
    const capabilities = GRANT_CAPABILITIES[id]

    // Ahead of every other branch, including the revoked one is not right —
    // a revoked device is revoked whoever it belongs to, and that is the more
    // specific fact. But ownership outranks the capability tables, because the
    // host stops honouring the rows they are read from.
    if (evidence.ownerSuspended && !evidence.revoked) {
      return {
        id,
        state: "suspended",
        capabilities,
        // Deliberately empty: these are what the device WOULD hold. Listing
        // them under a suspended row reads as "still has these".
        heldCapabilities: [],
        available: id !== "lockedComputerUse" || LOCKED_USE_AVAILABLE,
        reasonKey: "ownerMismatch",
      }
    }

    if (id === "lockedComputerUse") {
      return {
        id,
        state: !LOCKED_USE_AVAILABLE
          ? "denied"
          : evidence.revoked || !evidence.mirror.lockedComputerUse
            ? "denied"
            : "granted",
        capabilities,
        heldCapabilities: [],
        available: LOCKED_USE_AVAILABLE,
        reasonKey: LOCKED_USE_AVAILABLE ? undefined : "lockedUseUnavailable",
      }
    }

    const kind = id as "control" | "agentControl" | "terminal"

    if (evidence.revoked) {
      return {
        id,
        state: "denied",
        capabilities,
        heldCapabilities: [],
        available: true,
        reasonKey: "deviceRevoked",
      }
    }

    if (held) {
      const heldCapabilities = capabilities.filter((capability) => held.has(capability))
      return {
        id,
        state: stateFromCapabilities(capabilities, held),
        capabilities,
        heldCapabilities,
        available: true,
      }
    }

    if (evidence.hostVerdict) {
      const granted = evidence.hostVerdict[kind]
      return {
        id,
        state: granted ? "granted" : "denied",
        capabilities,
        heldCapabilities: granted ? capabilities : [],
        available: true,
      }
    }

    const granted = evidence.mirror[kind]
    return {
      id,
      state: granted ? "granted" : "denied",
      capabilities,
      heldCapabilities: granted ? capabilities : [],
      available: true,
      reasonKey: "mirrorOnly",
    }
  })
}

/**
 * True when the row confers anything at all — drives the switch's checked state.
 *
 * `suspended` is deliberately NOT enabled: the switch must read off, because
 * the host is refusing the grant right now. The row's reason line is what tells
 * the owner the grant is still recorded and will come back.
 */
export function isGrantEnabled(row: DeviceGrantRow): boolean {
  return row.state === "granted" || row.state === "partial"
}
