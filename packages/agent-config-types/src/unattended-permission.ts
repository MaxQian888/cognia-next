// What an unattended run may do without a person (ADR-0224 A7).
//
// A Bot installation and a scheduled task run with nobody watching, so each
// carries one permission profile: a level per permission class, folded
// through the same narrowing-only ceilings as the rest of its authority. The
// profile can only take autonomy away. Its ceiling is the ADR's rule:
//
//   - workspace file and shell work is allowed inside a verified sandbox and
//     asks a person anywhere else (`sandbox`);
//   - outbound messages, secret use and host configuration changes always ask
//     a person (`ask`), whatever the run's permission mode says.
//
// A layer may lower a class to `ask` (workspace) or `deny` (any class). An
// asking call parks the run until someone answers or the park times out
// (`lib/claude/unattended-permission-responder.ts`).
//
// The sidecar enforces the resolved profile (`SendOptions.permissionProfile`)
// in its permission ladder and, for the Claude Agent SDK whose bypass mode
// never consults the ladder, in a PreToolUse hook. It classifies built-in
// tools itself; plugin tools carry the classes the host derived from the
// plugin's declared permissions (`pluginTools[].permissionClasses`).

/** Wire-format version of {@link UnattendedPermissionProfileV1}. */
export const UNATTENDED_PERMISSION_PROFILE_SCHEMA_VERSION = 1

/** The classes a profile governs. Order is the settings UI's order. */
export const PERMISSION_CLASSES = ["workspace", "outbound", "secrets", "hostConfig"] as const

export type PermissionClass = (typeof PERMISSION_CLASSES)[number]

/**
 * - `sandbox`: allowed without asking inside a verified sandbox, asks elsewhere
 *   (workspace only).
 * - `ask`: a person approves each call; no permission mode or standing grant
 *   skips it for the outbound, secret and host-configuration classes.
 * - `deny`: refused without asking.
 */
export type PermissionClassLevel = "sandbox" | "ask" | "deny"

export type WorkspacePermissionLevel = "sandbox" | "ask" | "deny"
export type GuardedPermissionLevel = "ask" | "deny"

/** One layer's opinion. An absent class means the layer has none. */
export interface UnattendedPermissionProfileV1 {
  workspace?: WorkspacePermissionLevel
  outbound?: GuardedPermissionLevel
  secrets?: GuardedPermissionLevel
  hostConfig?: GuardedPermissionLevel
}

/** Every class decided: what the run actually gets. */
export type ResolvedPermissionProfile = Required<UnattendedPermissionProfileV1>

/** The ceiling, and what a run with no opinion anywhere gets. */
export const DEFAULT_PERMISSION_PROFILE: Readonly<ResolvedPermissionProfile> = Object.freeze({
  workspace: "sandbox",
  outbound: "ask",
  secrets: "ask",
  hostConfig: "ask",
})

/** The levels each class accepts, most permissive first. */
export const PERMISSION_CLASS_LEVELS: Readonly<
  Record<PermissionClass, readonly PermissionClassLevel[]>
> = Object.freeze({
  workspace: ["sandbox", "ask", "deny"],
  outbound: ["ask", "deny"],
  secrets: ["ask", "deny"],
  hostConfig: ["ask", "deny"],
})

const LEVEL_RANK: Readonly<Record<PermissionClassLevel, number>> = {
  deny: 0,
  ask: 1,
  sandbox: 2,
}

/** The stricter of two levels. */
export function narrowPermissionLevel<L extends PermissionClassLevel>(a: L, b: L): L {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b
}

/** Whether `level` is a legal level for `cls`. */
export function isPermissionLevelFor(cls: PermissionClass, level: unknown): boolean {
  return (
    typeof level === "string" && (PERMISSION_CLASS_LEVELS[cls] as readonly string[]).includes(level)
  )
}

/**
 * Fold two layers, `inner` on `outer`: each class keeps the stricter level
 * either layer named. A class neither layer names stays absent.
 */
export function narrowPermissionProfile(
  outer: UnattendedPermissionProfileV1 | undefined,
  inner: UnattendedPermissionProfileV1 | undefined
): UnattendedPermissionProfileV1 | undefined {
  if (!outer) return inner ? { ...inner } : undefined
  if (!inner) return { ...outer }
  const merged: UnattendedPermissionProfileV1 = {}
  for (const cls of PERMISSION_CLASSES) {
    const a = outer[cls]
    const b = inner[cls]
    const level = a && b ? narrowPermissionLevel(a, b) : (a ?? b)
    if (level) (merged as Record<PermissionClass, PermissionClassLevel>)[cls] = level
  }
  return merged
}

/** The levels a run gets: every class decided, never above the ceiling. */
export function resolvePermissionProfile(
  profile: UnattendedPermissionProfileV1 | undefined
): ResolvedPermissionProfile {
  const resolved = { ...DEFAULT_PERMISSION_PROFILE }
  for (const cls of PERMISSION_CLASSES) {
    const level = profile?.[cls]
    if (level && isPermissionLevelFor(cls, level)) {
      ;(resolved as Record<PermissionClass, PermissionClassLevel>)[cls] = narrowPermissionLevel(
        resolved[cls],
        level
      )
    }
  }
  return resolved
}

/**
 * The profile as a layer should store it: only the classes it narrows below
 * the ceiling, and undefined when that is none. A class written at the
 * ceiling is the same as no opinion, and storing it would make a layer look,
 * in a policy's provenance, as if it set something it never touched. An
 * unknown class or a level its class does not accept is dropped.
 */
export function compactPermissionProfile(
  profile: UnattendedPermissionProfileV1 | undefined
): UnattendedPermissionProfileV1 | undefined {
  if (!profile) return undefined
  const compact: Partial<Record<PermissionClass, PermissionClassLevel>> = {}
  for (const cls of PERMISSION_CLASSES) {
    const level = profile[cls]
    if (level && isPermissionLevelFor(cls, level) && level !== DEFAULT_PERMISSION_PROFILE[cls]) {
      compact[cls] = level
    }
  }
  return Object.keys(compact).length > 0 ? (compact as UnattendedPermissionProfileV1) : undefined
}

/**
 * Which classes `candidate` names at a level above the one `current` holds. A
 * layer that asks for more than is already in force is refused for those
 * classes, never applied; the settings UI lists what was refused. A class the
 * candidate does not name is no opinion, not a loosening.
 */
export function widenedPermissionClasses(
  current: UnattendedPermissionProfileV1 | undefined,
  candidate: UnattendedPermissionProfileV1 | undefined
): PermissionClass[] {
  const widened: PermissionClass[] = []
  for (const cls of PERMISSION_CLASSES) {
    const before = current?.[cls]
    const after = candidate?.[cls]
    if (before && after && LEVEL_RANK[after] > LEVEL_RANK[before]) widened.push(cls)
  }
  return widened
}

/**
 * Which classes `next` makes stricter than `previous`, comparing the levels
 * each resolves to. A run started under the looser profile must not keep
 * running once the profile tightens; callers cancel it.
 */
export function tightenedPermissionClasses(
  previous: UnattendedPermissionProfileV1 | undefined,
  next: UnattendedPermissionProfileV1 | undefined
): PermissionClass[] {
  const before = resolvePermissionProfile(previous)
  const after = resolvePermissionProfile(next)
  return PERMISSION_CLASSES.filter((cls) => LEVEL_RANK[after[cls]] < LEVEL_RANK[before[cls]])
}

/** Structural check for a profile crossing a trust boundary. */
export function validatePermissionProfile(
  value: unknown
): { ok: true; value: UnattendedPermissionProfileV1 } | { ok: false; errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["permissionProfile must be an object"] }
  }
  const errors: string[] = []
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(PERMISSION_CLASSES as readonly string[]).includes(key)) {
      errors.push(`permissionProfile.${key} is not a permission class`)
      continue
    }
    const cls = key as PermissionClass
    if (record[key] !== undefined && !isPermissionLevelFor(cls, record[key])) {
      errors.push(
        `permissionProfile.${key} must be one of ${PERMISSION_CLASS_LEVELS[cls].join("|")}`
      )
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as UnattendedPermissionProfileV1 }
}

/**
 * The host's word that this run's sandboxed tools execute inside an isolated
 * placement it established: the session's sandbox is on, its shell tier left
 * this machine, and the placement's preflight succeeded. Only such a run gets
 * the ladder's sandbox auto-allow. A placement that is later lost refuses
 * every sandboxed call rather than falling back to this machine, so an allow
 * granted against a stale attestation still cannot run on the host.
 */
export interface SandboxAttestationV1 {
  schemaVersion: 1
  /**
   * The shell tier the placement runs: `microvm`, a VM (or a container behind
   * the same seam); `container`, the project's runtime environment on an
   * always-on Host's sandbox pool (ADR-0224 A8).
   */
  tier: "microvm" | "container"
  /** When the host established the placement (epoch ms). */
  verifiedAt: number
}
