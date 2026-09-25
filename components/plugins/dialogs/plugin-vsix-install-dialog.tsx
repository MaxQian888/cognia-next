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
import {
  commitVscodeExtension,
  prepareVscodeExtension,
  type PreparedVscodeExtension,
} from "@/lib/plugin/vscode-shim/install-vscode-extension"
import { loggers } from "@cognia/logging"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Stage =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "ready"; prepared: PreparedVscodeExtension }
  | { kind: "installing"; prepared: PreparedVscodeExtension }
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
      // Adapt at *parse* time, not install time: the review below renders the
      // inferred permissions, and the user has to see them before consenting.
      const prepared = await prepareVscodeExtension(bytes, "vsix-upload")
      setStage({ kind: "ready", prepared })
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleInstall = async () => {
    if (stage.kind !== "ready") return
    const { prepared } = stage
    setStage({ kind: "installing", prepared })
    try {
      await commitVscodeExtension(prepared)
      onOpenChange(false)
      reset()
    } catch (err) {
      loggers.plugin.error("VSIX install failed", err, {
        extension: prepared.adapted.manifest.id,
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
      {/* Bounded to the viewport: header and footer stay put and whichever
          stage body is showing is the one scroller, so a long review (LSP
          binaries, notes, themes) can't push Install off a phone screen. The
          body's `-m-1 p-1` keeps focus rings from being clipped by it. */}
      <DialogContent className="flex max-h-[85dvh] w-[95vw] max-w-2xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileArchiveIcon className="size-4 shrink-0" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div
          className="-m-1 min-h-0 flex-1 overflow-y-auto p-1"
          data-testid="plugin-vsix-install-dialog-body"
        >
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
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{t("parseError")}</p>
                <p className="text-xs text-muted-foreground break-all">{stage.message}</p>
                <Button size="sm" variant="outline" onClick={reset}>
                  {t("retry")}
                </Button>
              </div>
            </Card>
          )}

          {(stage.kind === "ready" || stage.kind === "installing") && (
            <VsixReviewBody prepared={stage.prepared} installing={stage.kind === "installing"} />
          )}
        </div>

        <DialogFooter className="shrink-0">
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
  prepared,
  installing,
}: {
  prepared: PreparedVscodeExtension
  installing: boolean
}) {
  const t = useTranslations("plugins.vsixInstall")
  const { vsix, adapted } = prepared
  const { pkgJson, lspBinaryCandidates, themes, bundleFormat } = vsix
  // Permissions come from static analysis of the bundle, never from the
  // manifest. This used to read `pkgJson.permissions` — a field VS Code
  // manifests do not have — so the section below never rendered and every
  // install looked permission-free.
  const inference = adapted.permissions
  const permissions = inference.permissions

  return (
    <div aria-busy={installing} className="space-y-3">
      <Card className="p-3 text-sm space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium break-words">
            {pkgJson.displayName || pkgJson.name}
          </span>
          <Badge variant="secondary">v{pkgJson.version}</Badge>
          {bundleFormat && (
            <Badge variant="outline" className="text-xs">
              {bundleFormat}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("publisherLabel")}: <code className="break-all font-mono">{adapted.manifest.id}</code>
        </p>
        {pkgJson.description && (
          <p className="text-xs break-words text-muted-foreground">{pkgJson.description}</p>
        )}
      </Card>

      {lspBinaryCandidates.length > 0 && (
        <Card className="p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlertIcon className="size-4" />
            {t("sectionLspBinaries", { count: lspBinaryCandidates.length })}
          </div>
          {/* Full paths, wrapped rather than truncated: a hover tooltip is the
              only way to read a truncated one, and touch has no hover. */}
          <ul className="divide-y text-xs">
            {lspBinaryCandidates.map((c) => (
              <li key={c.path} className="flex items-start gap-2 py-1.5">
                <Badge variant="outline" className="text-xs">
                  {t(`lspBinaryKind.${c.kind}`)}
                </Badge>
                <code className="min-w-0 flex-1 break-all font-mono">{c.path}</code>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("lspBinaryNote")}</p>
        </Card>
      )}

      <Card className="p-3 text-sm space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{t("sectionPermissions")}</span>
          <Badge variant="outline" className="text-xs">
            {t("permissionsConfidence", { confidence: inference.confidence })}
          </Badge>
        </div>
        {permissions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-xs font-mono">
                {p}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("permissionsNone")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("permissionsInferred")}</p>
        {inference.unparsedBundle && (
          <p className="text-xs text-muted-foreground">{t("permissionsUnparsed")}</p>
        )}
      </Card>

      {adapted.warnings.length > 0 && (
        <Card className="p-3 text-sm space-y-2">
          <div className="font-medium">{t("sectionNotes", { count: adapted.warnings.length })}</div>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {adapted.warnings.map((w) => (
              <li key={w} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {themes.length > 0 && (
        <Card className="p-3 text-sm space-y-2">
          <div className="font-medium">{t("sectionThemes", { count: themes.length })}</div>
          <ul className="text-xs space-y-0.5">
            {themes.map((th) => (
              <li key={th.path} className="flex min-w-0 items-center gap-2">
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
