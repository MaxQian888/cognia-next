"use client"

// Renders a row count for every populated table in the v3 backup payload,
// preceded by the manifest header (backend / app version / exported-at /
// schema version / integrity prefix / trace id). This is a "blast radius"
// preview shown before the user clicks Apply.

import { useTranslations } from "next-intl"
import type { BackupPackageV3, BackupPayloadV3 } from "@/lib/data/types"

const FIELDS: Array<{
  key: keyof BackupPackageV3["payload"]
  labelKey: string
}> = [
  { key: "settings", labelKey: "settings" },
  { key: "characters", labelKey: "characters" },
  { key: "skills", labelKey: "skills" },
  { key: "skillResources", labelKey: "skillResources" },
  { key: "teams", labelKey: "teams" },
  { key: "promptPresets", labelKey: "promptPresets" },
  { key: "mcpServers", labelKey: "mcpServers" },
  { key: "sessions", labelKey: "sessions" },
  { key: "messages", labelKey: "messages" },
  { key: "sessionState", labelKey: "sessionState" },
  { key: "trustedWorkspaces", labelKey: "trustedWorkspaces" },
  { key: "ttsProviderKeys", labelKey: "ttsProviderKeys" },
  { key: "canvasDocuments", labelKey: "canvasDocuments" },
  { key: "canvasVersions", labelKey: "canvasVersions" },
  { key: "canvasComments", labelKey: "canvasComments" },
  { key: "canvasSessions", labelKey: "canvasSessions" },
  { key: "a2uiApps", labelKey: "a2uiApps" },
  { key: "a2uiTemplates", labelKey: "a2uiTemplates" },
  { key: "a2uiEventHistory", labelKey: "a2uiEventHistory" },
  { key: "plugins", labelKey: "plugins" },
  { key: "pluginPermissions", labelKey: "pluginPermissions" },
  { key: "pluginReviews", labelKey: "pluginReviews" },
  { key: "pluginAnalytics", labelKey: "pluginAnalytics" },
]

/**
 * Row counts for a v3 payload — the "blast radius" half of the preview, split
 * out so the per-domain import can show the same numbers.
 *
 * A `DomainExportFile.payload` *is* a `BackupPayloadV3`, but a domain file has
 * no manifest, so only this part is shared; the manifest header stays in
 * `ImportPreview`. Keeping one counting loop means the two dialogs can't drift
 * on what "12 characters" means.
 */
export function PayloadRowCounts({ payload }: { payload: BackupPayloadV3 }) {
  const snapshotCount = Object.keys(payload.localStorageSnapshots ?? {}).length
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
      {FIELDS.map((f) => {
        const v = payload[f.key]
        const count = Array.isArray(v) ? v.length : v ? 1 : 0
        return (
          <li key={f.key as string}>
            <span className="font-mono">{f.labelKey}:</span>{" "}
            <span className={count > 0 ? "" : "italic"}>{count}</span>
          </li>
        )
      })}
      {snapshotCount > 0 && (
        <li>
          {/* i18n-exempt: raw payload key name, not UI prose */}
          <span className="font-mono">localStorageSnapshots:</span> <span>{snapshotCount}</span>
        </li>
      )}
    </ul>
  )
}

export function ImportPreview({ pkg }: { pkg: BackupPackageV3 }) {
  const t = useTranslations("settings.data")
  const integrityShort = pkg.manifest.integrity.checksum.slice(0, 12)
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <p className="mb-2 font-medium">{t("preview")}</p>
      <p className="text-[11px] text-muted-foreground">
        {t("backup.previewBackend", {
          backend: pkg.manifest.backend,
          appVersion: pkg.manifest.appVersion,
          exportedAt: formatExported(pkg.manifest.exportedAt),
        })}
      </p>
      <p className="mb-2 break-all font-mono text-[10px] text-muted-foreground">
        {/* i18n-exempt: technical manifest diagnostics — schema/integrity/trace ids, not UI prose */}
        schema v{pkg.manifest.schemaVersion} · integrity {integrityShort}… · trace{" "}
        {pkg.manifest.traceId.slice(0, 8)}
      </p>
      <PayloadRowCounts payload={pkg.payload} />
    </div>
  )
}

function formatExported(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
