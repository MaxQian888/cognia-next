/**
 * Normalization and effective-policy resolution for `AppSettings.webReader`.
 *
 * Three starting points, decided by the persisted ROW, never by merged
 * defaults (a merged read cannot tell "never chose" from "chose the default"):
 *
 * - **Fresh install** (no settings row): direct-first, origin platform
 *   scrapers on, every remote recipient (FxTwitter, Jina, vendor readers)
 *   off, external fallback off, distillation off.
 * - **Upgrade** (a row without its own `webReader`): the legacy compatibility
 *   profile — the platform scrapers, FxTwitter and Jina stay eligible exactly
 *   as before (Jina only where the host has a CORS-free transport), external
 *   fallback stays on, no vendor reader is enabled, and `alwaysDistill: true`
 *   becomes `required`. No usage history exists, so this preserves prior
 *   eligibility; it does not infer prior use.
 * - **Explicit** valid record: authoritative.
 *
 * A record with an unknown future `version` is preserved verbatim by the
 * caller but never activated here. Reads stay pure: the normalized profile is
 * materialized only when the user saves.
 */

import type {
  AppSettings,
  StoredWebReaderSettings,
  WebReaderDistillation,
  WebReaderEntry,
  WebReaderId,
  WebReaderSettingsV1,
} from "@cognia/agent-config-types"
import { REMOTE_WEB_READER_IDS, WEB_READER_IDS } from "@cognia/agent-config-types"
import { MAX_OPERATION_ATTEMPTS, READ_TOTAL_BUDGET_MS } from "@cognia/web-search/operation-policy"

export const WEB_READER_MIN_TIMEOUT_MS = 5_000

const DEFAULT_PRIORITIES: Record<WebReaderId, number> = {
  direct: 0,
  platform: 1,
  fxtwitter: 2,
  jina: 10,
  tavily: 11,
  exa: 12,
  deepseek: 13,
  tinyfish: 14,
}

function entries(
  enabled: Partial<Record<WebReaderId, boolean>>
): Record<WebReaderId, WebReaderEntry> {
  return Object.fromEntries(
    WEB_READER_IDS.map((id) => [
      id,
      { enabled: enabled[id] === true, priority: DEFAULT_PRIORITIES[id] },
    ])
  ) as Record<WebReaderId, WebReaderEntry>
}

/** New-install defaults: nothing leaves the machine unless the user selects it. */
export function freshInstallWebReader(): WebReaderSettingsV1 {
  return {
    version: 1,
    defaultReader: "auto",
    readers: entries({ direct: true, platform: true }),
    externalFallback: "off",
    distillation: "off",
  }
}

/** Upgrade compatibility: what an existing install already did, nothing more. */
export function legacyCompatibilityWebReader(
  webTools: AppSettings["webTools"] | undefined
): WebReaderSettingsV1 {
  return {
    version: 1,
    defaultReader: "auto",
    readers: entries({ direct: true, platform: true, fxtwitter: true, jina: true }),
    externalFallback: "configured",
    distillation: webTools?.alwaysDistill === true ? "required" : "off",
  }
}

export type WebReaderSettingsSource = "fresh" | "legacy" | "explicit" | "unsupported-version"

export interface NormalizedWebReaderSettings {
  /** The policy to run with. */
  effective: WebReaderSettingsV1
  source: WebReaderSettingsSource
  /** The stored record to keep verbatim (unknown future versions), if any. */
  preserved?: StoredWebReaderSettings
}

const DISTILLATION: readonly WebReaderDistillation[] = ["off", "best-effort", "required"]

function clamp(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeV1(raw: Record<string, unknown>): WebReaderSettingsV1 {
  const base = freshInstallWebReader()
  const rawReaders = isRecord(raw.readers) ? raw.readers : {}
  const readers = { ...base.readers } as Record<WebReaderId, WebReaderEntry>
  for (const id of WEB_READER_IDS) {
    const entry = rawReaders[id]
    if (!isRecord(entry)) {
      // Unlisted in an explicit record ⇒ off, except the direct reader, which
      // is the host's own request and has no recipient to consent to.
      readers[id] = { enabled: id === "direct", priority: DEFAULT_PRIORITIES[id] }
      continue
    }
    readers[id] = {
      enabled: entry.enabled === true,
      priority: clamp(entry.priority, 0, 1000) ?? DEFAULT_PRIORITIES[id],
    }
  }
  const defaultReader =
    raw.defaultReader === "auto" || WEB_READER_IDS.includes(raw.defaultReader as WebReaderId)
      ? (raw.defaultReader as WebReaderSettingsV1["defaultReader"])
      : "auto"
  const timeoutMs = clamp(raw.timeoutMs, WEB_READER_MIN_TIMEOUT_MS, READ_TOTAL_BUDGET_MS)
  const maxAttempts = clamp(raw.maxAttempts, 1, MAX_OPERATION_ATTEMPTS)
  return {
    version: 1,
    defaultReader,
    readers,
    externalFallback: raw.externalFallback === "configured" ? "configured" : "off",
    distillation: DISTILLATION.includes(raw.distillation as WebReaderDistillation)
      ? (raw.distillation as WebReaderDistillation)
      : "off",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  }
}

/**
 * Normalize a stored `webReader` value.
 *
 * @param raw        the value as persisted on the row (`row.webReader`)
 * @param rowExists  whether a settings row existed at all (false ⇒ fresh install)
 * @param webTools   the row's `webTools`, for the legacy `alwaysDistill` mapping
 */
export function normalizeWebReaderSettings(
  raw: unknown,
  context: { rowExists: boolean; webTools?: AppSettings["webTools"] }
): NormalizedWebReaderSettings {
  const fallback = () =>
    context.rowExists ? legacyCompatibilityWebReader(context.webTools) : freshInstallWebReader()
  if (raw === undefined || raw === null) {
    return { effective: fallback(), source: context.rowExists ? "legacy" : "fresh" }
  }
  if (!isRecord(raw)) {
    return { effective: fallback(), source: context.rowExists ? "legacy" : "fresh" }
  }
  if (raw.version !== 1) {
    return {
      effective: fallback(),
      source: "unsupported-version",
      ...(typeof raw.version === "number" ? { preserved: raw as StoredWebReaderSettings } : {}),
    }
  }
  return { effective: normalizeV1(raw), source: "explicit" }
}

/** The runtime view of a normalized policy, as the configured Reader consumes it. */
export interface ReaderPolicy {
  defaultReader: "auto" | WebReaderId
  /** Enabled readers. */
  enabled: ReadonlySet<WebReaderId>
  /** Enabled remote readers usable as external fallback, in priority order. */
  externalOrder: WebReaderId[]
  externalFallback: boolean
  distillation: WebReaderDistillation
  timeoutMs: number
  maxAttempts: number
  /** Opaque revision for cache identity; changes whenever routing could change. */
  revision: string
}

export function toReaderPolicy(settings: WebReaderSettingsV1): ReaderPolicy {
  const enabled = new Set<WebReaderId>(
    WEB_READER_IDS.filter((id) => settings.readers[id]?.enabled === true)
  )
  const externalOrder = REMOTE_WEB_READER_IDS.filter(
    (id) => enabled.has(id) && id !== "fxtwitter"
  ).sort(
    (a, b) =>
      (settings.readers[a]?.priority ?? DEFAULT_PRIORITIES[a]) -
      (settings.readers[b]?.priority ?? DEFAULT_PRIORITIES[b])
  )
  const timeoutMs = settings.timeoutMs ?? READ_TOTAL_BUDGET_MS
  const maxAttempts = settings.maxAttempts ?? MAX_OPERATION_ATTEMPTS
  return {
    defaultReader: settings.defaultReader,
    enabled,
    externalOrder,
    externalFallback: settings.externalFallback === "configured",
    distillation: settings.distillation,
    timeoutMs,
    maxAttempts,
    revision: [
      settings.defaultReader,
      [...enabled].sort().join(","),
      externalOrder.join(","),
      settings.externalFallback,
      settings.distillation,
    ].join("|"),
  }
}

/**
 * Resolve the effective Reader policy straight from an `AppSettings`
 * snapshot whose `webReader` the settings loader already normalized (absent ⇒
 * treated as an upgrade, which is the conservative reading for a snapshot
 * that cannot prove it is a fresh install).
 */
export function readerPolicyFromSettings(settings: AppSettings | undefined | null): ReaderPolicy {
  const normalized = normalizeWebReaderSettings(settings?.webReader, {
    rowExists: true,
    webTools: settings?.webTools,
  })
  return toReaderPolicy(normalized.effective)
}
