"use client"

/**
 * Per-twin embedding card for the workbench Settings tab.
 *
 * Lets the user pin the embedding model THIS twin embeds with (or inherit the
 * global twin-runtime embedding), shows which model built the twin's current
 * index, warns when the two differ (retrieval then skips twin RAG with a
 * `rebuild-required` reason), and rebuilds the index with the effective model.
 *
 * Credentials are never entered here: an override on the global provider
 * reuses the global key; another provider uses the chat-provider settings
 * (see `resolveTwinEmbeddingConfig`).
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  RAG_EMBEDDING_PROVIDERS,
  getEmbeddingProviderDescriptor,
  isRagEmbeddingProvider,
  type RagEmbeddingProvider,
} from "@cognia/provider-embedding/embedding-catalog"
import { getTwin, setTwinEmbeddingOverride } from "@/lib/db/twins"
import { countTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { observeTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { rebuildTwinIndex } from "@/lib/twin/lifecycle"
import {
  computeTwinEmbeddingStatus,
  type TwinEmbeddingStatus,
} from "@/lib/twin/runtime/twin-embedding-status"
import type { EmbeddingProviderSettingsMap } from "@/lib/twin/runtime/twin-embedding"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_TWIN_RUNTIME_SETTINGS, type TwinEmbeddingOverride } from "@/types/twin"

const INHERIT = "__inherit__"

interface Draft {
  /** `INHERIT` or a provider id. */
  choice: string
  model: string
}

function draftFrom(override: TwinEmbeddingOverride | undefined): Draft {
  return override
    ? { choice: override.provider, model: override.model ?? "" }
    : { choice: INHERIT, model: "" }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.choice === b.choice && a.model.trim() === b.model.trim()
}

export function TwinEmbeddingCard({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.embeddingOverride")
  const twin = useLiveQuery(() => getTwin(twinId), [twinId], undefined)
  const runtime = useLiveQuery(
    () => observeTwinRuntimeSettings(),
    [],
    DEFAULT_TWIN_RUNTIME_SETTINGS
  )
  const chunkCount = useLiveQuery(() => countTwinChunksByTwin(twinId), [twinId], 0)
  const providerSettings = useSettingsStore((state) => state.settings?.providerSettings)

  const status = useMemo<TwinEmbeddingStatus>(
    () =>
      computeTwinEmbeddingStatus({
        twinId,
        twin,
        global: runtime.embedding,
        providerSettings: providerSettings as EmbeddingProviderSettingsMap | undefined,
        chunkCount,
      }),
    [twinId, twin, runtime.embedding, providerSettings, chunkCount]
  )

  const saved = useMemo(() => draftFrom(twin?.embedding), [twin?.embedding])
  const [draft, setDraft] = useState<Draft>(saved)
  const dirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)

  // Follow the live row until the user starts editing.
  useEffect(() => {
    if (dirtyRef.current) return
    setDraft(saved)
  }, [saved])

  const dirty = !sameDraft(draft, saved)
  const draftProvider: RagEmbeddingProvider | undefined = isRagEmbeddingProvider(draft.choice)
    ? draft.choice
    : undefined

  const update = (next: Draft) => {
    dirtyRef.current = true
    setDraft(next)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await setTwinEmbeddingOverride(
        twinId,
        draftProvider ? { provider: draftProvider, model: draft.model } : undefined
      )
      dirtyRef.current = false
      toast.success(t("saved"))
    } catch (error) {
      toast.error(
        t("saveFailed", { message: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setSaving(false)
    }
  }

  const handleRebuild = async () => {
    setRebuilding(true)
    try {
      const result = await rebuildTwinIndex(twinId)
      if (!result.ok) {
        toast.error(
          t("rebuildFailed", { stage: t(`stage.${result.stage}`), message: result.error })
        )
      } else if (!result.rebuilt || !result.value) {
        toast.error(t("rebuildTwinMissing"))
      } else {
        toast.success(t("rebuildQueued", { count: result.value.sourceIds.length }))
      }
    } catch (error) {
      toast.error(
        t("rebuildFailed", {
          stage: t("stage.database"),
          message: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setRebuilding(false)
    }
  }

  const index = status.index

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="twin-embedding-card">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-muted-foreground text-xs">{t("description")}</p>
      </header>

      <div className="grid gap-3 @md/twin:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-embedding-provider">{t("providerLabel")}</Label>
          <Select
            value={draft.choice}
            onValueChange={(choice) =>
              update({ choice, model: choice === draft.choice ? draft.model : "" })
            }
          >
            <SelectTrigger
              id="twin-embedding-provider"
              aria-label={t("providerLabel")}
              data-testid="twin-embedding-provider"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                {t("inheritGlobal", {
                  provider: status.global.provider,
                  model: status.global.model,
                })}
              </SelectItem>
              {RAG_EMBEDDING_PROVIDERS.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {provider}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-embedding-model">{t("modelLabel")}</Label>
          <Input
            id="twin-embedding-model"
            data-testid="twin-embedding-model"
            value={draft.model}
            disabled={!draftProvider}
            placeholder={
              draftProvider
                ? t("modelPlaceholder", {
                    model: getEmbeddingProviderDescriptor(draftProvider).defaultModel,
                  })
                : t("modelInherited")
            }
            onChange={(event) => update({ ...draft, model: event.target.value })}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs" data-testid="twin-embedding-status">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {t("effective", {
              provider: status.effective.provider,
              model: status.effective.model,
            })}
          </span>
          <Badge variant="outline">
            {status.source === "twin" ? t("sourceTwin") : t("sourceGlobal")}
          </Badge>
        </div>
        <span className="text-muted-foreground">
          {index
            ? t("indexBuiltWith", {
                provider: index.provider,
                model: index.model,
                dimensions: index.dimensions ?? "?",
                when: new Date(index.builtAt).toLocaleString(),
              })
            : status.legacyIndex
              ? t("indexLegacy")
              : t("indexEmpty")}
        </span>
        {status.rebuildRequired && index ? (
          <p
            className="text-destructive"
            role="alert"
            data-testid="twin-embedding-rebuild-required"
          >
            {t("rebuildRequired", {
              indexProvider: index.provider,
              indexModel: index.model,
              provider: status.effective.provider,
              model: status.effective.model,
            })}
          </p>
        ) : null}
        {status.legacyIndex && status.source === "twin" ? (
          <p className="text-destructive" role="status" data-testid="twin-embedding-legacy-warning">
            {t("legacyWithOverride")}
          </p>
        ) : null}
        {!status.credentialsReady ? (
          <p className="text-destructive" role="status" data-testid="twin-embedding-credentials">
            {t("credentialsMissing", { provider: status.effective.provider })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 @xs/twin:flex-row @xs/twin:items-center @xs/twin:justify-end">
        {dirty ? (
          <span className="text-muted-foreground text-xs">{t("saveBeforeRebuild")}</span>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              data-testid="twin-embedding-rebuild"
              disabled={rebuilding || dirty || !status.credentialsReady}
            >
              {rebuilding ? (
                <>
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                  {t("rebuilding")}
                </>
              ) : (
                t("rebuild")
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("rebuildDialogTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("rebuildDialogBody", {
                  provider: status.effective.provider,
                  model: status.effective.model,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                data-testid="twin-embedding-rebuild-confirm"
                onClick={() => void handleRebuild()}
              >
                {t("rebuildConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button
          data-testid="twin-embedding-save"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
        >
          {saving ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              {t("saving")}
            </>
          ) : (
            t("save")
          )}
        </Button>
      </div>
    </Card>
  )
}
