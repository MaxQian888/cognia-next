"use client"

// A2UI Templates tab — surfaces the 14 built-in templates (read-only)
// alongside user-defined templates from the Dexie `a2uiTemplates` table.
// Provides import / export / delete; editing happens in the Hub Workspace.

import { useEffect, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { DownloadIcon, UploadIcon, Trash2Icon, ExternalLinkIcon, FilePlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
import { listTemplates, upsertTemplate, deleteTemplate } from "@/lib/db/a2ui-templates"
import { appTemplates } from "@/lib/a2ui/templates"
import type { A2UITemplateRow } from "@/lib/db/a2ui-types"
import { loggers } from "@/lib/logging"

export function TemplatesTab() {
  const t = useTranslations("settings.a2ui.templates")
  const [userTemplates, setUserTemplates] = useState<A2UITemplateRow[]>([])
  const builtIns = appTemplates

  const refresh = async () => {
    const rows = await listTemplates()
    setUserTemplates(rows)
  }

  useEffect(() => {
    let cancelled = false
    listTemplates().then((rows) => {
      if (!cancelled) setUserTemplates(rows)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const onExport = (row: A2UITemplateRow) => {
    const blob = new Blob([JSON.stringify(row, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${row.name.toLowerCase().replace(/\s+/g, "-")}.a2ui.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const onImport = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as A2UITemplateRow
      // Sanity: enforce the expected shape; assign new id to avoid clobbering.
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.components)) {
        throw new Error("Invalid template file")
      }
      const now = Date.now()
      const row: A2UITemplateRow = {
        ...parsed,
        id: `tpl-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        isBuiltIn: false,
        source: "imported",
        createdAt: now,
        updatedAt: now,
      }
      await upsertTemplate(row)
      toast.success(t("toast.importSuccess", { name: row.name }))
      void refresh()
    } catch (err) {
      loggers.a2ui.error("template import failed", { error: String(err) })
      toast.error(t("toast.importFailed"))
    }
  }

  const onDelete = async (id: string, name: string) => {
    if (!confirm(t("confirmDelete", { name }))) return
    await deleteTemplate(id)
    toast.success(t("toast.deleted", { name }))
    void refresh()
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t("user.title")}</CardTitle>
              <CardDescription>{t("user.description")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/a2ui">
                  <FilePlusIcon className="mr-1 size-3.5" />
                  {t("user.openHub")}
                  <ExternalLinkIcon className="ml-1 size-3" />
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <label>
                  <UploadIcon className="mr-1 size-3.5" />
                  {t("user.import")}
                  <input
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void onImport(f)
                      e.target.value = ""
                    }}
                  />
                </label>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {userTemplates.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">{t("user.empty")}</p>
          ) : (
            userTemplates.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{row.name}</span>
                    <Badge variant="secondary">{row.category}</Badge>
                    {row.source === "imported" ? (
                      <Badge variant="outline">{t("imported")}</Badge>
                    ) : null}
                  </div>
                  {row.description ? (
                    <div className="truncate text-xs text-muted-foreground">{row.description}</div>
                  ) : null}
                </div>
                <div className="ml-2 flex items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={() => onExport(row)}>
                    <DownloadIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void onDelete(row.id, row.name)}
                  >
                    <Trash2Icon className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("builtIn.title", { count: builtIns.length })}
          </CardTitle>
          <CardDescription>{t("builtIn.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-72">
            <div className="space-y-1">
              {builtIns.map((tpl) => (
                <div
                  key={tpl.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{tpl.name}</span>
                      <Badge variant="secondary">{tpl.category}</Badge>
                      <Badge>{t("builtInBadge")}</Badge>
                    </div>
                    {tpl.description ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {tpl.description}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
