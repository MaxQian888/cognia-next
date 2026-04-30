"use client"

// Per-domain export / import + external imports. Each domain (skills, MCP,
// presets, characters, teams, theme) gets its own row with Export / Import
// buttons. External imports (ChatGPT / Claude / Gemini) live in their own
// card at the top.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ChatImportDialog } from "@/components/data/import/chat-import-dialog"
import { DomainImportDialog } from "@/components/data/import/domain-import-dialog"
import {
  buildDomainExport,
  defaultDomainFileName,
  serializeDomainFile,
  DOMAIN_TRANSFERS,
  type DomainKey,
} from "@/lib/data/domain"
import { isTauri } from "@/lib/tauri"
import { toast } from "sonner"
import { GlobeIcon, MessageSquareIcon, SparklesIcon, DownloadIcon, UploadIcon } from "lucide-react"

const PLATFORMS: Array<{
  id: "chatgpt" | "claude" | "gemini"
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: "chatgpt", icon: MessageSquareIcon },
  { id: "claude", icon: SparklesIcon },
  { id: "gemini", icon: GlobeIcon },
]

export function DomainTransferTab() {
  return (
    <div className="space-y-6">
      <ExternalImportsCard />
      <PerDomainCard />
    </div>
  )
}

function ExternalImportsCard() {
  const t = useTranslations("settings.data")
  return (
    <Card className="space-y-3 p-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("domain.externalTitle")}</Label>
        <p className="text-xs text-muted-foreground">{t("domain.externalBody")}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {PLATFORMS.map((p) => (
          <ChatImportDialog
            key={p.id}
            defaultPlatform={p.id}
            trigger={
              <Card className="flex cursor-pointer flex-col items-start gap-1 p-3 transition hover:border-primary/50 hover:bg-muted/50">
                <p.icon className="size-5" />
                <span className="text-sm font-medium">
                  {t(`domain.platform.${p.id}.title` as never)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t(`domain.platform.${p.id}.body` as never)}
                </span>
              </Card>
            }
          />
        ))}
      </div>
    </Card>
  )
}

function PerDomainCard() {
  const t = useTranslations("settings.data")
  return (
    <Card className="space-y-3 p-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("domain.perDomainTitle")}</Label>
        <p className="text-xs text-muted-foreground">{t("domain.perDomainBody")}</p>
      </div>
      <ul className="divide-y rounded-md border">
        {DOMAIN_TRANSFERS.map((spec) => (
          <DomainRow key={spec.key} domain={spec.key} labelKey={spec.labelKey} />
        ))}
      </ul>
    </Card>
  )
}

function DomainRow({ domain, labelKey }: { domain: DomainKey; labelKey: string }) {
  const t = useTranslations("settings.data")
  const [busy, setBusy] = useState(false)

  const onExport = async () => {
    setBusy(true)
    try {
      const file = await buildDomainExport(domain)
      const json = serializeDomainFile(file)
      const fileName = defaultDomainFileName(domain)
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { writeTextFile } = await import("@tauri-apps/plugin-fs")
        const path = await save({
          defaultPath: fileName,
          filters: [{ name: "Cognia domain", extensions: ["json"] }],
        })
        if (!path) return
        await writeTextFile(path, json)
        toast.success(t("exportSuccess"))
      } else {
        const blob = new Blob([json], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileName
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t(`domain.${labelKey}.title` as never)}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {t(`domain.${labelKey}.body` as never)}
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => void onExport()}
          disabled={busy}
        >
          <DownloadIcon className="mr-1 size-3.5" />
          {t("domain.exportRow")}
        </Button>
        <DomainImportDialog
          domain={domain}
          trigger={
            <Button variant="outline" size="sm" className="h-8 text-xs">
              <UploadIcon className="mr-1 size-3.5" />
              {t("domain.importRow")}
            </Button>
          }
        />
      </div>
    </li>
  )
}
