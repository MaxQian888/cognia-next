"use client"

/**
 * Author `.cognia/hosting.json` from inside the console.
 *
 * The manifest is the hard precondition for provisioning bindings, building a
 * version, and running a preview, and until now nothing in the app could
 * create it — all three actions failed with a raw file-read error pointing at
 * a path the user had never heard of. This is the missing half: detect the
 * project, generate a reviewable starting point, validate against the real
 * parser on every keystroke, and write it.
 *
 * The draft lives here rather than in the hook: it is unsaved UI state, and the
 * component is keyed by Site id upstream so switching Sites re-seeds it without
 * a set-state-in-effect.
 */
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FileJsonIcon, RefreshCwIcon, SparklesIcon } from "lucide-react"

import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { SITE_MANIFEST_RELATIVE_PATH } from "@/lib/sites/manifest-file"
import { parseSiteHostingManifest } from "@/lib/sites/manifest"
import { serializeSiteHostingManifest, type SiteScaffoldFile } from "@/lib/sites/manifest-scaffold"
import { cn } from "@/lib/utils"
import type { SiteHostingManifestController } from "@/hooks/sites/use-site-hosting-manifest"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"

export interface SiteManifestEditorProps {
  manifest: SiteHostingManifestController
  gate: SiteGate
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  /** Runs the write through the console's shared busy/toast runner. */
  onSave: (text: string, extraFiles?: readonly SiteScaffoldFile[]) => void
}

interface DraftValidation {
  valid: boolean
  error?: string
}

export function SiteManifestEditor({ manifest, gate, isBusy, onSave }: SiteManifestEditorProps) {
  const t = useTranslations("sites")
  const [draft, setDraft] = useState(manifest.text)
  const [seededFrom, setSeededFrom] = useState(manifest.text)
  const [pendingFiles, setPendingFiles] = useState<readonly SiteScaffoldFile[]>([])
  const [detected, setDetected] = useState<{
    kind: string
    packageManager: string
    template: boolean
  } | null>(null)
  const [scaffolding, setScaffolding] = useState(false)

  const state = manifest.state
  const disabled = isBusy("manifest") || !gate.allowed

  // Re-seed when the file on disk changes underneath the editor (first read,
  // reload, or a save that rewrote it). This is React's "adjust state when
  // props change" pattern — done during render, not in an effect, so there is
  // no cascading second render. Guarded on the file's text, so typing is never
  // clobbered by a re-render that changed nothing.
  if (manifest.text !== seededFrom) {
    setSeededFrom(manifest.text)
    setDraft(manifest.text)
  }

  const validation = useMemo<DraftValidation>(() => {
    if (!draft.trim()) return { valid: false }
    try {
      parseSiteHostingManifest(draft)
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, [draft])

  const format = () => {
    try {
      setDraft(serializeSiteHostingManifest(parseSiteHostingManifest(draft)))
    } catch {
      // Formatting an unparseable draft is a no-op; the inline error already
      // says what is wrong.
    }
  }

  const scaffold = async () => {
    setScaffolding(true)
    try {
      const result = await manifest.scaffold()
      if (!result) return
      setDraft(result.text)
      setPendingFiles(result.extraFiles)
      setDetected({
        kind: result.kind,
        packageManager: result.packageManager,
        template: result.confidence === "template",
      })
    } finally {
      setScaffolding(false)
    }
  }

  if (state.status === "unsupported") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="site-manifest-unsupported">
        {t("manifest.unsupported")}
      </p>
    )
  }

  if (state.status === "loading") {
    return <p className="text-xs text-muted-foreground">{t("manifest.loading")}</p>
  }

  if (state.status === "missing" && !draft) {
    return (
      <Empty
        className="gap-3 rounded-lg border border-dashed px-4 py-8"
        data-testid="site-manifest-missing"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
            <FileJsonIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-sm">{t("manifest.missing.title")}</EmptyTitle>
          <EmptyDescription className="max-w-[24rem] text-xs">
            {t("manifest.missing.description")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            type="button"
            size="sm"
            disabled={disabled || scaffolding}
            title={gate.title}
            onClick={() => void scaffold()}
            data-testid="site-manifest-scaffold"
          >
            <SparklesIcon aria-hidden className="size-4" />
            {t("actions.scaffoldManifest")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="space-y-2" data-testid="site-manifest-editor">
      <div className="overflow-hidden rounded-lg border">
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/40 px-3 py-1.5">
          <FileJsonIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={state.path}>
            {SITE_MANIFEST_RELATIVE_PATH}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!validation.valid}
            onClick={format}
          >
            {t("actions.formatManifest")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={isBusy("manifest")}
            onClick={() => void manifest.refresh()}
          >
            <RefreshCwIcon aria-hidden className="size-3" />
            {t("actions.reloadManifest")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled || scaffolding}
            title={gate.title}
            onClick={() => void scaffold()}
            data-testid="site-manifest-scaffold"
          >
            <SparklesIcon aria-hidden className="size-3" />
            {t("actions.scaffoldManifest")}
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={disabled || !validation.valid}
            title={gate.title}
            onClick={() => onSave(draft, pendingFiles)}
            data-testid="site-manifest-save"
          >
            {t("actions.saveManifest")}
          </Button>
        </div>

        <LightCodeEditor
          language="json"
          value={draft}
          onChange={setDraft}
          readOnly={!gate.allowed}
          className="h-64"
          aria-label={t("manifest.editorLabel")}
          data-testid="site-manifest-source"
        />

        {validation.error ? (
          <p
            role="alert"
            className="border-t border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive"
          >
            {t("manifest.invalid", { error: validation.error })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {detected ? (
          <>
            <Badge variant="outline" className="font-normal">
              {t("manifest.detected", {
                kind: t(`manifest.kind.${detected.kind}`),
                packageManager: detected.packageManager,
              })}
            </Badge>
            <span className={cn(detected.template && "text-warning")}>
              {t(
                detected.template ? "manifest.confidence.template" : "manifest.confidence.detected"
              )}
            </span>
          </>
        ) : null}
        {pendingFiles.length > 0 ? (
          <span>{t("manifest.extraFiles", { count: pendingFiles.length })}</span>
        ) : null}
      </div>
    </div>
  )
}
