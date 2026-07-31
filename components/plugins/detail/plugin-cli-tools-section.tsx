"use client"

// CLI Tools section of the Capabilities sub-tab — lists every declarative
// `manifest.cliTools` entry with the wrapped binary's live status pill
// (available + version / below minimum / missing). Missing binaries show
// the manifest's documentation deep-link plus a re-probe action that
// drops the native detection cache (detect_binary_invalidate) so a fresh
// install shows up without waiting out the 300s TTL.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, RefreshCwIcon, TerminalSquareIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  getPluginBinaryStatuses,
  type PluginBinaryStatus,
} from "@/lib/plugin/cli-tools/binary-status"
import type { PluginCliToolDef, PluginManifest } from "@/types/plugin"

function binaryNameOf(def: PluginCliToolDef): string {
  return def.binary.kind === "requires" ? def.binary.name : def.binary.relPath
}

export function PluginCliToolsSection({ manifest }: { manifest: PluginManifest }) {
  const t = useTranslations("plugins.detail.cliTools")
  const cliTools = Array.isArray(manifest.cliTools) ? manifest.cliTools : []
  const [statuses, setStatuses] = useState<Map<string, PluginBinaryStatus>>(new Map())
  const [probing, setProbing] = useState(false)

  const probe = useCallback(async () => {
    setProbing(true)
    try {
      const results = await getPluginBinaryStatuses(manifest)
      setStatuses(new Map(results.map((status) => [status.name, status])))
    } finally {
      setProbing(false)
    }
  }, [manifest])

  useEffect(() => {
    if (cliTools.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const results = await getPluginBinaryStatuses(manifest)
        if (!cancelled) {
          setStatuses(new Map(results.map((status) => [status.name, status])))
        }
      } catch {
        // Probe failures leave pills in the "missing" default.
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest])

  const handleReprobe = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await Promise.all(
        (manifest.requires?.binaries ?? []).map((bin) =>
          invoke("detect_binary_invalidate", { name: bin.name }).catch(() => undefined)
        )
      )
    } catch {
      // Web mode — nothing cached natively.
    }
    await probe().catch(() => undefined)
  }, [manifest, probe])

  if (cliTools.length === 0) {
    return null
  }

  return (
    <Card className="p-3 space-y-2" data-testid="plugin-cli-tools-section">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <TerminalSquareIcon className="size-3.5" />
          {t("title")}
        </div>
        <Button variant="ghost" size="sm" onClick={handleReprobe} disabled={probing}>
          <RefreshCwIcon className="size-3.5" />
          {t("reprobe")}
        </Button>
      </div>
      <ul className="space-y-2">
        {cliTools.map((def) => {
          const status = def.binary.kind === "requires" ? statuses.get(def.binary.name) : undefined
          return (
            <li key={def.name} className="flex flex-wrap items-center gap-2 text-sm">
              <code className="font-mono text-xs">{def.name}</code>
              <span className="text-xs text-muted-foreground flex-1 min-w-32 truncate">
                {def.description}
              </span>
              <span className="text-xs text-muted-foreground font-mono">{binaryNameOf(def)}</span>
              {def.binary.kind === "requires" &&
                (status?.available && status.satisfiesMin ? (
                  <Badge variant="outline" data-testid={`cli-binary-ok-${def.name}`}>
                    {t("available", { version: status.version ?? "?" })}
                  </Badge>
                ) : status?.available ? (
                  <Badge variant="destructive" data-testid={`cli-binary-old-${def.name}`}>
                    {t("belowMin", { min: status.minVersion ?? "?" })}
                  </Badge>
                ) : (
                  <Badge variant="destructive" data-testid={`cli-binary-missing-${def.name}`}>
                    {t("missing")}
                  </Badge>
                ))}
              {def.binary.kind === "requires" &&
                status &&
                !(status.available && status.satisfiesMin) &&
                status.documentation && (
                  <a
                    href={status.documentation}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs underline text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLinkIcon className="size-3" />
                    {t("installHelp")}
                  </a>
                )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
