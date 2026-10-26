"use client"

/**
 * Detail of a prompt resource kept by its own owner (ADR-0236 §5.1): a
 * character, preset, Skill, custom mode, instruction file, workspace record,
 * app setting or chat template. Every write goes through the owner's adapter,
 * which says what the editor may do: save in place, save into a custom copy or
 * variant, make a preset the default, return a variant's prompt to its base,
 * or only read. A file save is checked against the hash it was read at; a
 * change made on disk since then is shown as a diff against the user's text
 * and never silently overwritten or thrown away.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangleIcon, ExternalLinkIcon, InfoIcon } from "lucide-react"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"
import { useOwnerPromptDocument } from "@/hooks/prompts/use-owner-prompt-document"
import { computeDiff } from "@/lib/artifacts/diff"
import { isWorkspaceFileConflict } from "@/lib/files/workspace-fs"
import { ownerAdapterFor } from "@/lib/prompts/adapters"
import type {
  OwnerPromptDocument,
  PromptResourceContext,
  PromptResourceSummary,
} from "@/lib/prompts/resources"
import { settingsHref } from "@/lib/settings/deep-link"
import { WORKSPACE_INSTRUCTIONS_MAX_CHARS } from "@/lib/workspace/workspace-instructions"
import { PromptBodyEditor } from "./prompt-body-editor"
import { usePromptLabels } from "./use-prompt-labels"

export interface OwnerPromptDetailProps {
  resource: PromptResourceSummary
  ctx: PromptResourceContext
  /** An owner changed; the list should reload. */
  onChanged(): void
  /** Show another resource (a copy or variant just created). */
  onSelect(key: string): void
}

export function OwnerPromptDetail({ resource, ctx, onChanged, onSelect }: OwnerPromptDetailProps) {
  const { t } = usePromptLabels()
  const router = useRouter()
  const adapter = ownerAdapterFor(resource.key)
  const { state, reload } = useOwnerPromptDocument(resource.key, ctx)
  const document = state.status === "ready" ? state.document : undefined

  // The editor text and the document it was seeded from.
  const [text, setText] = useState("")
  const [seededFrom, setSeededFrom] = useState<OwnerPromptDocument | null>(null)
  if (document && document !== seededFrom) {
    // A reload of the same text (after our own save) keeps nothing to lose;
    // a different resource always starts from its own text.
    setSeededFrom(document)
    setText(document.text)
  }
  const dirty = document !== undefined && text !== document.text
  const [busy, setBusy] = useState(false)
  /** The file as it is on disk after a rejected save. */
  const [conflict, setConflict] = useState<OwnerPromptDocument | null>(null)
  const [conflictFor, setConflictFor] = useState(resource.key)
  if (conflictFor !== resource.key) {
    setConflictFor(resource.key)
    setConflict(null)
  }

  const ownerOnly = resource.edit === "owner-only"
  const customCopy = resource.edit === "custom-copy"
  const maxChars =
    resource.source === "workspace-instructions" ? WORKSPACE_INSTRUCTIONS_MAX_CHARS : undefined
  const tooLong = maxChars !== undefined && text.length > maxChars
  const name = resource.name ?? resource.key

  const fail = (error: unknown) =>
    toast.error(
      t("toast.failed", { message: error instanceof Error ? error.message : String(error) })
    )

  const save = async (version: string | undefined) => {
    if (!adapter?.save || !document) return
    setBusy(true)
    try {
      await adapter.save(resource.key, text, version, ctx)
      setConflict(null)
      toast.success(t("toast.saved"))
      onChanged()
      reload()
    } catch (error) {
      if (isWorkspaceFileConflict(error)) {
        try {
          setConflict((await adapter.read(resource.key, ctx)) ?? null)
        } catch (readError) {
          fail(readError)
        }
      } else fail(error)
    } finally {
      setBusy(false)
    }
  }

  const saveCustom = async () => {
    if (!adapter?.saveCustom) return
    setBusy(true)
    try {
      const key = await adapter.saveCustom(resource.key, text, ctx, {
        name: t("owner.customCopyName", { name }),
      })
      toast.success(t("toast.customSaved"))
      onChanged()
      onSelect(key)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async () => {
    if (!adapter?.makeDefault) return
    setBusy(true)
    try {
      await adapter.makeDefault(resource.key, ctx)
      toast.success(t("toast.madeDefault", { name }))
      onChanged()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const followBase = async () => {
    if (!adapter?.reset) return
    setBusy(true)
    try {
      await adapter.reset(resource.key, ctx)
      toast.success(t("toast.followsBase"))
      onChanged()
      reload()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const compareBase = document?.baseText ?? document?.text ?? ""
  const diff = useMemo(() => computeDiff(compareBase, text), [compareBase, text])
  const conflictDiff = useMemo(
    () => (conflict ? computeDiff(conflict.text, text) : []),
    [conflict, text]
  )

  return (
    <div className="space-y-4" data-testid="owner-prompt-detail">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">
              {resource.source === "app-setting" ? t("owner.defaultSystemPrompt") : name}
            </h3>
            <Badge variant="outline" className="text-[10px]">
              {t(`source.${resource.source}`)}
            </Badge>
            {resource.builtIn ? (
              <Badge variant="secondary" className="text-[10px]">
                {t("owner.builtIn")}
              </Badge>
            ) : null}
          </div>
          {resource.detail ? (
            <p className="text-xs text-muted-foreground">
              {resource.source === "instruction-file"
                ? t(`instructionSource.${resource.detail}`)
                : resource.detail}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t(`ownerActivation.${resource.source}`)}</p>
        </div>
        {resource.ownerSection ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            onClick={() => router.push(settingsHref(resource.ownerSection as SettingsSectionId))}
          >
            <ExternalLinkIcon className="size-3.5" />
            {t(`owner.openIn.${resource.ownerSection}`)}
          </Button>
        ) : null}
      </header>

      {state.status === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("owner.loading")}</p>
      ) : state.status === "missing" ? (
        <p className="text-xs text-muted-foreground">{t("owner.missing")}</p>
      ) : state.status === "error" ? (
        <Alert variant="destructive">
          <AlertTriangleIcon className="size-4" />
          <AlertTitle>{t("owner.readFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {state.error}
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={reload}>
              {t("actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {ownerOnly ? (
            <Alert>
              <InfoIcon className="size-4" />
              <AlertDescription>{t(`owner.ownerOnly.${resource.source}`)}</AlertDescription>
            </Alert>
          ) : document?.readOnlyReason ? (
            <Alert>
              <InfoIcon className="size-4" />
              <AlertTitle>{t(`owner.readOnly.${document.readOnlyReason}`)}</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {t(`owner.customHint.${resource.source}`)}
                {document.customKey ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => onSelect(document.customKey!)}
                  >
                    {t("owner.openCustom")}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {conflict ? (
            <Alert variant="destructive" data-testid="owner-file-conflict">
              <AlertTriangleIcon className="size-4" />
              <AlertTitle>{t("conflict.title")}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{t("conflict.body")}</p>
                <LineDiffView
                  lines={conflictDiff}
                  wrap
                  maxHeight={260}
                  aria-label={t("conflict.diffLabel")}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void save(conflict.version)}>
                    {t("conflict.keepMine")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setConflict(null)
                      setSeededFrom(null)
                      reload()
                    }}
                  >
                    {t("conflict.takeDisk")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <Tabs defaultValue="edit">
            <TabsList>
              <TabsTrigger value="edit">{t("tabs.edit")}</TabsTrigger>
              <TabsTrigger value="compare">
                {document?.baseText !== undefined ? t("tabs.compareBase") : t("tabs.compareSaved")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="edit" className="space-y-3">
              <PromptBodyEditor
                value={text}
                onChange={setText}
                readOnly={ownerOnly}
                maxChars={maxChars}
                issues={
                  tooLong ? [{ code: "too-long", limit: maxChars!, length: text.length }] : []
                }
                label={name}
              />
              {ownerOnly ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  {customCopy ? (
                    <Button size="sm" disabled={busy || !dirty} onClick={() => void saveCustom()}>
                      {document?.customKey && resource.source === "character"
                        ? t("actions.updateVariant")
                        : t("actions.saveCustom")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy || !dirty || tooLong || conflict !== null}
                      onClick={() => void save(document?.version)}
                    >
                      {t("actions.save")}
                    </Button>
                  )}
                  {dirty ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setText(document?.text ?? "")}
                    >
                      {t("actions.revertEdits")}
                    </Button>
                  ) : null}
                  {adapter?.makeDefault ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void makeDefault()}
                    >
                      {t("actions.makeDefault")}
                    </Button>
                  ) : null}
                  {adapter?.reset &&
                  document?.baseText !== undefined &&
                  document.baseText !== document.text ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void followBase()}
                    >
                      {t("actions.followBase")}
                    </Button>
                  ) : null}
                </div>
              )}
            </TabsContent>
            <TabsContent value="compare">
              {diff.some((line) => line.type !== "unchanged") ? (
                <LineDiffView
                  lines={diff}
                  wrap
                  maxHeight={480}
                  aria-label={t("compare.diffLabel")}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{t("compare.identical")}</p>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
