/**
 * Single-source taxonomy of the risk surfaces an autonomous run can touch.
 *
 * Mirrors `lib/settings/permission-mode-meta.ts`: an exhaustive `Record` keyed
 * by the surface id, so adding a `RiskSurfaceId` without describing it here is
 * a compile error rather than a silently unclassified surface. User-facing text
 * lives in i18n under `policy.risk.surfaces.*`, keyed by
 * {@link RiskSurfaceMeta.i18nKey}; this module holds only the non-localized
 * metadata so it stays framework-agnostic and testable.
 *
 * Consumed by `classify-risk.ts` (severity → tier) and, later, by any UI that
 * wants to name the surfaces a run tripped. Per ADR-0070.
 */

/** How severe a tripped surface is. Maps onto `RiskTier` in `classify-risk.ts`. */
export type RiskSeverity = "elevated" | "high"

export type RiskSurfaceId =
  /** Connector / IM send reaching a real recipient — irreversible. */
  | "external-send"
  /** Screen / mouse / keyboard automation of the operator's machine. */
  | "computer-use"
  /** Bash / shell / native OS command execution. */
  | "native-command"
  /** Delete / drop / wipe / truncate / reset intent against real data. */
  | "data-destructive"
  /** Keyring / auth / subscription / secret access. */
  | "credential-auth"
  /** Write / Edit reaching the filesystem outside a sandbox. */
  | "file-write-broad"

export interface RiskSurfaceMeta {
  severity: RiskSeverity
  /** i18n key suffix under `policy.risk.surfaces.*` (label + description). */
  i18nKey: RiskSurfaceId
}

/**
 * The severity of each surface.
 *
 * `high` is reserved for surfaces whose effects escape the app and cannot be
 * undone by closing it: a message a human already read, an OS-level action, a
 * destroyed record. `elevated` covers surfaces that are dangerous in aggregate
 * but individually contained — reading a credential, writing a file.
 */
export const RISK_SURFACES: Record<RiskSurfaceId, RiskSurfaceMeta> = {
  "external-send": { severity: "high", i18nKey: "external-send" },
  "computer-use": { severity: "high", i18nKey: "computer-use" },
  "native-command": { severity: "high", i18nKey: "native-command" },
  "data-destructive": { severity: "high", i18nKey: "data-destructive" },
  "credential-auth": { severity: "elevated", i18nKey: "credential-auth" },
  "file-write-broad": { severity: "elevated", i18nKey: "file-write-broad" },
}

/** Every risk surface id, derived from the exhaustive meta record. */
export const RISK_SURFACE_IDS = Object.keys(RISK_SURFACES) as RiskSurfaceId[]

/** The metadata for a surface. */
export function riskSurfaceMeta(id: RiskSurfaceId): RiskSurfaceMeta {
  return RISK_SURFACES[id]
}
