"use client"

// Renders a row count for every populated table in the v3 backup payload.
// Numbers are non-clickable on purpose — this is a "blast radius" preview
// shown before the user clicks Apply.

import { useTranslations } from "next-intl"
import type { BackupPackageV3 } from "@/lib/data/types"

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
]

export function ImportPreview({ pkg }: { pkg: BackupPackageV3 }) {
  const t = useTranslations("settings.data")
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <p className="mb-2 font-medium">{t("preview")}</p>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {t("backup.previewBackend", {
          backend: pkg.manifest.backend,
          appVersion: pkg.manifest.appVersion,
          exportedAt: formatExported(pkg.manifest.exportedAt),
        })}
      </p>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
        {FIELDS.map((f) => {
          const v = pkg.payload[f.key]
          const count = Array.isArray(v) ? v.length : v ? 1 : 0
          return (
            <li key={f.key as string}>
              <span className="font-mono">{f.labelKey}:</span>{" "}
              <span className={count > 0 ? "" : "italic"}>{count}</span>
            </li>
          )
        })}
      </ul>
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
