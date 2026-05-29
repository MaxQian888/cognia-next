"use client"

// Manage GitHub "marketplace repo" sources (Claude-Code-style plugin
// dispatch). Add a repo that ships a marketplace.json catalog; its plugins
// then appear in the browse grid. Lists saved sources with a remove action.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, Loader2Icon, PlusIcon, Trash2Icon, GitBranchIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { useGithubMarketplaceSources } from "@/hooks/plugins/use-github-marketplace-sources"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PluginMarketplaceSourcesDialog({ open, onOpenChange }: Props) {
  const t = useTranslations("plugins.marketplaceSources")
  const { sources, add, remove } = useGithubMarketplaceSources()
  const [repoRef, setRepoRef] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async () => {
    const trimmed = repoRef.trim()
    if (!trimmed) {
      setError(t("emptyError"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await add(trimmed)
      setRepoRef("")
    } catch (err) {
      setError(t("addError", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="marketplace-source-ref">{t("label")}</Label>
          <div className="flex gap-2">
            <Input
              id="marketplace-source-ref"
              placeholder={t("placeholder")}
              value={repoRef}
              onChange={(e) => setRepoRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void handleAdd()
              }}
              disabled={busy}
            />
            <Button
              onClick={() => void handleAdd()}
              disabled={busy}
              aria-label={t("add")}
              data-testid="add-source-submit"
            >
              {busy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
            </Button>
          </div>
          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="space-y-2">
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            sources.map((source) => (
              <Card
                key={source.id}
                className="flex items-center justify-between gap-2 p-2.5"
                data-testid={`marketplace-source-${source.id}`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{source.name}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">
                    {source.repoRef}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={t("remove", { name: source.name })}
                  onClick={() => void remove(source.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </Card>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
