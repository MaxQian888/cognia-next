"use client"

// VSCode extension (.vsix) install dialog.
//
// Drives the user-facing flow that closes ADR 0016's last gap for LSP
// adoption: pick a `.vsix`, parse it with `installVsix` (in-memory parse +
// LSP binary candidate detection + theme extraction), let the user review
// what it will register, then call the Rust `plugin_vscode_install_vsix`
// command to actually unpack on disk and stage a Dexie row.
//
// Permissions / LSP binary policy adjudication happens server-side
// (`lib/plugin/vscode-shim/lsp-binary-policy.ts` for each binary spawn).
// This dialog surfaces the candidates so the user knows what they are
// agreeing to before installing.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  FileArchiveIcon,
  FilePlus2Icon,
  Loader2Icon,
  ShieldAlertIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { installVsix, type VsixInstallResult } from "@/lib/plugin/vscode-shim/vsix-installer"
import { upsertPlugin } from "@/lib/db/plugins"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { loggers } from "@cognia/logging"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Stage =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "ready"; result: VsixInstallResult; vsixBytes: Uint8Array }
  | { kind: "installing"; result: VsixInstallResult; vsixBytes: Uint8Array }
  | { kind: "error"; message: string }

export function PluginVsixInstallDialog({ open, onOpenChange }: Props) {
  const t = useTranslations("plugins.vsixInstall")
  const [stage, setStage] = useState<Stage>({ kind: "idle" })

  const reset = () => setStage({ kind: "idle" })

  const handlePick = async () => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".vsix"
    const files = await new Promise<File[]>((resolve) => {
      input.onchange = () => resolve(Array.from(input.files ?? []))
      input.oncancel = () => resolve([])
      input.click()
    })
    if (files.length === 0) return
    const file = files[0]
    if (!file) return
    setStage({ kind: "parsing" })
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const result = await installVsix(bytes)
      setStage({ kind: "ready", result, vsixBytes: bytes })
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleInstall = async () => {
    if (stage.kind !== "ready") return
    const { result, vsixBytes } = stage
    setStage({ kind: "installing", result, vsixBytes })
    try {
      const tauriAvailable = canUseTauriInvoke()
      let installPath: string | null = null
      if (tauriAvailable) {
        const base64 = bytesToBase64(vsixBytes)
        const { invoke } = await import("@tauri-apps/api/core")
        const installResult = await invoke<{
          extensionId: string
          installPath: string
          sha256Hex: string
          packageJson: unknown
        }>("plugin_vscode_install_vsix", { vsixBase64: base64 })
        installPath = installResult.installPath
      }
      const publisher = result.pkgJson.publisher
      const name = result.pkgJson.name
      const id = `${publisher}.${name}`
      await upsertPlugin({
        id,
        name: result.pkgJson.displayName || result.pkgJson.name,
        version: result.pkgJson.version,
        status: "discovered",
        source: "local",
        type: "vscode-extension",
        path: installPath ?? `vsix://${id}@${result.sha256.slice(0, 12)}`,
        manifest: result.pkgJson as unknown as Record<string, unknown>,
        enabled: false,
        capabilities: ["vscode-extension"],
      })
      onOpenChange(false)
      reset()
    } catch (err) {
      loggers.plugin.error("VSIX install failed", err, {
        extension: stage.result.pkgJson.publisher + "." + stage.result.pkgJson.name,
      })
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleClose = (next: boolean) => {
    onOpenChange(next)
    if (!next) reset()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="w-[95vw] max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchiveIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {stage.kind === "idle" && (
          <div className="flex flex-col items-center justify-center gap-2 py-6">
            <Button onClick={() => void handlePick()}>
              <FilePlus2Icon className="size-4 mr-2" />
              {t("choose")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("hint")}</p>
          </div>
        )}

        {stage.kind === "parsing" && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t("parsing")}
          </div>
        )}

        {stage.kind === "error" && (
          <Card className="flex items-start gap-2 border-destructive p-3 text-sm" role="alert">
            <AlertTriangleIcon className="size-4 text-destructive shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{t("parseError")}</p>
              <p className="text-xs text-muted-foreground break-all">{stage.message}</p>
              <Button size="sm" variant="outline" onClick={reset}>
                {t("retry")}
              </Button>
            </div>
          </Card>
        )}

        {(stage.kind === "ready" || stage.kind === "installing") && (
          <VsixReviewBody result={stage.result} installing={stage.kind === "installing"} />
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={stage.kind === "installing"}
          >
            {t("cancel")}
          </Button>
          {(stage.kind === "ready" || stage.kind === "installing") && (
            <Button onClick={() => void handleInstall()} disabled={stage.kind === "installing"}>
              {stage.kind === "installing" ? (
                <>
                  <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
                  {t("installing")}
                </>
              ) : (
                t("install")
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VsixReviewBody({
  result,
  installing,
}: {
  result: VsixInstallResult
  installing: boolean
}) {
  const t = useTranslations("plugins.vsixInstall")
  const { pkgJson, lspBinaryCandidates, themes, bundleFormat } = result
  const permissions = (pkgJson as { permissions?: string[] }).permissions ?? []

  return (
    <div aria-busy={installing} className="space-y-3">
      <Card className="p-3 text-sm space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{pkgJson.displayName || pkgJson.name}</span>
          <Badge variant="secondary">v{pkgJson.version}</Badge>
          {bundleFormat && (
            <Badge variant="outline" className="text-xs">
              {bundleFormat}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("publisherLabel")}:{" "}
          <code className="font-mono">
            {pkgJson.publisher}.{pkgJson.name}
          </code>
        </p>
        {pkgJson.description && (
          <p className="text-xs text-muted-foreground">{pkgJson.description}</p>
        )}
      </Card>

      {lspBinaryCandidates.length > 0 && (
        <Card className="p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlertIcon className="size-4" />
            {t("sectionLspBinaries", { count: lspBinaryCandidates.length })}
          </div>
          <ScrollArea className="max-h-[20vh]">
            <ul className="divide-y text-xs">
              {lspBinaryCandidates.map((c) => (
                <li key={c.path} className="flex items-center gap-2 py-1.5">
                  <Badge variant="outline" className="text-xs">
                    {t(`lspBinaryKind.${c.kind}`)}
                  </Badge>
                  <code className="font-mono flex-1 truncate" title={c.path}>
                    {c.path}
                  </code>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">{t("lspBinaryNote")}</p>
        </Card>
      )}

      {permissions.length > 0 && (
        <Card className="p-3 text-sm space-y-2">
          <div className="font-medium">{t("sectionPermissions")}</div>
          <div className="flex flex-wrap gap-1">
            {permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-xs font-mono">
                {p}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {themes.length > 0 && (
        <Card className="p-3 text-sm space-y-2">
          <div className="font-medium">{t("sectionThemes", { count: themes.length })}</div>
          <ul className="text-xs space-y-0.5">
            {themes.map((th) => (
              <li key={th.path} className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  {th.uiTheme ?? "—"}
                </Badge>
                <span className="truncate">{th.label}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function bytesToBase64(bytes: Uint8Array): string {
  // Browser-safe base64 — chunk to avoid btoa stack overflows on large
  // payloads (200 MB cap, ~270 MB base64). 32 KB per chunk keeps memory
  // pressure bounded.
  const chunk = 32 * 1024
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[])
  }
  return typeof btoa !== "undefined"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64")
}
