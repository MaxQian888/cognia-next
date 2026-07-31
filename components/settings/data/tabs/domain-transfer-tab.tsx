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
import { SessionImportDialog } from "@/components/session-import/session-import-dialog"
import {
  buildDomainExport,
  defaultDomainFileName,
  serializeDomainFile,
  getAllDomainTransfers,
  type DomainKey,
} from "@/lib/data/domain"
import { isTauri } from "@/lib/tauri"
import { toast } from "sonner"
import {
  GlobeIcon,
  MessageSquareIcon,
  SparklesIcon,
  DownloadIcon,
  UploadIcon,
  TerminalIcon,
} from "lucide-react"

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
      <AgentSessionsCard />
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

function AgentSessionsCard() {
  const t = useTranslations("sessionImport")
  return (
    <Card className="space-y-3 p-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("cardTitle")}</Label>
        <p className="text-xs text-muted-foreground">{t("cardBody")}</p>
      </div>
      <SessionImportDialog
        trigger={
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <TerminalIcon className="mr-1 size-3.5" />
            {t("title")}
          </Button>
        }
      />
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
        {/* `getAllDomainTransfers()`, not the static `DOMAIN_TRANSFERS` array:
            the §A-5 overlay lets plugins contribute transfer specs, and
            rendering the static list meant a registered spec could never
            appear here. */}
        {getAllDomainTransfers().map((spec) => (
          <DomainRow
            key={spec.key}
            domain={spec.key}
            labelKey={spec.labelKey}
            displayName={spec.displayName}
          />
        ))}
      </ul>
    </Card>
  )
}

function DomainRow({
  domain,
  labelKey,
  displayName,
}: {
  domain: DomainKey
  labelKey: string
  displayName?: string
}) {
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
    <li className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0 flex-1">
        {/* Plugin-contributed specs carry their own label — they have no entry
            in the app's message catalog, so translating would print the key. */}
        <p className="text-sm font-medium">
          {displayName ?? t(`domain.${labelKey}.title` as never)}
        </p>
        {!displayName && (
          <p className="truncate text-[11px] text-muted-foreground">
            {t(`domain.${labelKey}.body` as never)}
          </p>
        )}
      </div>
      <div className="flex w-full shrink-0 gap-1.5 sm:w-auto">
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 text-xs sm:flex-none"
          onClick={() => void onExport()}
          disabled={busy}
        >
          <DownloadIcon className="mr-1 size-3.5" />
          {t("domain.exportRow")}
        </Button>
        <DomainImportDialog
          domain={domain}
          labelKey={labelKey}
          trigger={
            <Button variant="outline" size="sm" className="h-8 flex-1 text-xs sm:flex-none">
              <UploadIcon className="mr-1 size-3.5" />
              {t("domain.importRow")}
            </Button>
          }
        />
      </div>
    </li>
  )
}
