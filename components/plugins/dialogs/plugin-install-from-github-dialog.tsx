"use client"

// Install a conforming plugin straight from a public GitHub repo. The user
// pastes a repo reference (`owner/repo`, `owner/repo@ref`, a `/sub/dir`, or a
// full github.com URL); we fetch a build-free preview (manifest + README +
// LICENSE) over the GitHub API, render it, and on confirm route the install
// through the SAME pre-install chain the marketplace uses (conflict →
// permission → binaries → config) via a GitHub-source `MarketplaceClient`.
//
// Desktop-only — the disk install runs in Rust (`plugin_install_from_github`).
// The launching toolbar item is gated on `canUseTauriInvoke()`.

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { GitBranchIcon, AlertTriangleIcon, Loader2Icon, DownloadIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { PluginLicense } from "../_shared/plugin-license"
import { PluginDependencyPanel } from "../_shared/plugin-dependency-panel"
import { usePluginPreInstall } from "@/hooks/plugins/use-plugin-pre-install"
import { PluginPreInstallDialog } from "./plugin-pre-install-dialog"
import {
  parseGithubPluginRef,
  fetchGithubPluginPreview,
  makeGithubMarketplaceClient,
  type GithubPluginPreview,
  type GithubMarketplaceClient,
} from "@/lib/plugin/package/github-source"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * When set, the dialog opens pre-filled with this repo reference and
   * auto-fetches its preview. Used by marketplace-repo cards so installing a
   * catalog entry reuses this exact preview + pre-install flow.
   */
  initialRef?: string
}

const SOURCE_MESSAGE_KEYS = {
  cognia: "sourceCognia",
  "claude-code": "sourceClaudeCode",
  codex: "sourceCodex",
  "gemini-cli": "sourceGeminiCli",
} as const

const FIDELITY_MESSAGE_KEYS = {
  "native-exact": "fidelityNativeExact",
  structured: "fidelityStructured",
  contextual: "fidelityContextual",
  unsupported: "fidelityUnsupported",
} as const

export function PluginInstallFromGithubDialog({ open, onOpenChange, initialRef }: Props) {
  const t = useTranslations("plugins.githubDialog")
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<GithubPluginPreview | null>(null)
  const [client, setClient] = useState<GithubMarketplaceClient | null>(null)
  const autoFetchedRef = useRef<string | null>(null)

  const preInstall = usePluginPreInstall(client)

  const reset = () => {
    setUrl("")
    setLoading(false)
    setError(null)
    setPreview(null)
    setClient(null)
    autoFetchedRef.current = null
  }

  const runFetch = async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) {
      setError(t("emptyError"))
      return
    }
    setUrl(trimmed)
    setLoading(true)
    setError(null)
    setPreview(null)
    setClient(null)
    try {
      const ref = parseGithubPluginRef(trimmed)
      const next = await fetchGithubPluginPreview(ref)
      setPreview(next)
      setClient(makeGithubMarketplaceClient(next.ref, next))
    } catch (err) {
      setError(t("fetchError", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setLoading(false)
    }
  }

  const handleFetch = () => void runFetch(url)

  // Auto-fetch when opened pre-filled from a marketplace-repo card.
  useEffect(() => {
    if (open && initialRef && autoFetchedRef.current !== initialRef) {
      autoFetchedRef.current = initialRef
      void runFetch(initialRef)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRef])

  const handleInstall = () => {
    if (!preview || !client) return
    if (!canUseTauriInvoke()) {
      setError(t("desktopOnly"))
      return
    }
    const { manifest } = preview
    void preInstall.install(manifest.id, undefined, manifest.name).then((result) => {
      if (result.status === "installed") {
        toast.success(t("installSucceeded", { name: manifest.name }))
        reset()
        onOpenChange(false)
      } else if (result.status === "cancelled") {
        toast.message(t("installCancelled"))
      } else if (result.status === "failed") {
        toast.error(t("installFailed", { message: result.message }))
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="plugin-github-url">{t("label")}</Label>
          <div className="flex gap-2">
            <Input
              id="plugin-github-url"
              placeholder={t("placeholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) void handleFetch()
              }}
              disabled={loading}
            />
            <Button variant="outline" onClick={() => void handleFetch()} disabled={loading}>
              {loading ? <Loader2Icon className="size-3.5 animate-spin" /> : t("fetch")}
            </Button>
          </div>
          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        {preview && (
          <ScrollArea className="flex-1 min-h-0 -mx-1 px-1">
            <div className="space-y-3" data-testid="plugin-github-preview">
              <Card className="p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{preview.manifest.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    v{preview.manifest.version}
                  </span>
                </div>
                {preview.manifest.description && (
                  <p className="text-xs text-muted-foreground">{preview.manifest.description}</p>
                )}
                <PluginLicense
                  license={preview.manifest.license}
                  licenseText={preview.license}
                  className="pt-1"
                />
              </Card>

              <Card className="p-3 space-y-1.5" data-testid="plugin-conversion-report">
                <div className="font-medium text-sm">{t("conversionTitle")}</div>
                <p className="text-xs text-muted-foreground">
                  {t("conversionSource", {
                    source: t(SOURCE_MESSAGE_KEYS[preview.sourceFormat]),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(FIDELITY_MESSAGE_KEYS[preview.conversionReport.fidelity])}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("conversionCounts", {
                    converted: preview.conversionReport.converted.length,
                    warnings: preview.conversionReport.warnings.length,
                  })}
                </p>
              </Card>

              <PluginDependencyPanel manifest={preview.manifest} />

              {preview.readme && (
                <Card className="p-3">
                  <div className="text-xs font-semibold mb-2">{t("readme")}</div>
                  <div className="text-sm">
                    <MarkdownRenderer
                      content={preview.readme}
                      enableMermaid={false}
                      enableMath={false}
                      rhythm="document"
                    />
                  </div>
                </Card>
              )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={preInstall.busy}>
            {t("cancel")}
          </Button>
          <Button onClick={handleInstall} disabled={!preview || preInstall.busy}>
            {preInstall.busy ? (
              <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
            ) : (
              <DownloadIcon className="size-3.5 mr-1.5" />
            )}
            {t("install")}
          </Button>
        </DialogFooter>
      </DialogContent>

      <PluginPreInstallDialog
        target={preInstall.target}
        onContinue={preInstall.resolveContinue}
        onCancel={preInstall.resolveCancel}
      />
    </Dialog>
  )
}
