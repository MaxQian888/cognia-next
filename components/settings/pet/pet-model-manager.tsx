// Settings → Pet → Live2D model manager. Lists installed models (live via
// useLiveQuery), lets the user set one active or delete it, imports from a folder
// or a .zip, downloads official sample models, and shows storage usage. The
// import/download/validation/persist logic lives in `pet-model-import.ts` so
// this component stays presentational and its test can mock those helpers.

"use client"

import { Input } from "@/components/ui/input"
import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Trash2Icon, UploadIcon, FolderIcon, DownloadIcon } from "lucide-react"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import { FieldDescription, FieldGroup } from "@/components/ui/field"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SettingsIcon as AnimatedSettingsIcon } from "@/components/ui/settings"
import {
  listPetModels,
  deletePetModel,
  getPetModelStorageUsage,
  type PetModelRow,
} from "@/lib/db/pet-models"
import { SAMPLE_MODEL_CATALOG } from "@/lib/pet/live2d/constants"
import { discoverLive2dModels, type DiscoveredModel } from "@/lib/pet/live2d/discover-models"
import { formatBytes } from "@/lib/agent/utils"
import type { PetAssetDiagnostic, PetSettings } from "@/types/pet"
import { toPetAssetDiagnostics } from "@/lib/pet/live2d/compatibility-diagnostics"
import { PetSkinStatus } from "@/components/pet/settings/pet-skin-status"
import {
  filesToEntries,
  importModelFromEntries,
  downloadSampleModel,
  type ImportOutcome,
} from "./pet-model-import"
import { PetModelConfigDialog } from "./pet-model-config-dialog"
import { PetModelImportDialog } from "./pet-model-import-dialog"

export interface PetModelManagerProps {
  settings: PetSettings
  onPatch: (patch: Partial<PetSettings>) => void
  coreReady?: boolean
}

const IMPORT_ACCEPT = ".zip,.model3.json,.moc3,.png,.json"

export function PetModelManager({ settings, onPatch, coreReady }: PetModelManagerProps) {
  const t = useTranslations("settings.pet.live2d")
  const models = useLiveQuery(() => listPetModels(), [], [] as PetModelRow[])
  const usage = useLiveQuery(() => getPetModelStorageUsage(), [models], {
    models: 0,
    totalBytes: 0,
  })

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [configModelId, setConfigModelId] = useState<string | null>(null)
  const configModel = models.find((m) => m.id === configModelId) ?? null
  // Set when a picked bundle holds >1 model — opens the selection dialog.
  const [importModels, setImportModels] = useState<DiscoveredModel[] | null>(null)

  const activeId = settings.activeLive2dModelId
  const activeModel = models.find((model) => model.id === activeId)
  const compatibilityDiagnostics: PetAssetDiagnostic[] = activeModel?.compatibility
    ? toPetAssetDiagnostics(activeModel.compatibility.diagnostics)
    : []
  if (!activeId || !activeModel) {
    compatibilityDiagnostics.push({
      code: "assetMissing",
      severity: "error",
      recoverable: true,
    })
  } else if (coreReady === false) {
    compatibilityDiagnostics.push({
      code: "runtimeUnavailable",
      severity: "error",
      recoverable: true,
    })
  }
  const effectiveSkin =
    activeModel && activeModel.compatibility?.status !== "invalid" && coreReady !== false
      ? "live2d"
      : "svg"

  function applyOutcome(outcome: ImportOutcome): void {
    if (outcome.ok) {
      setErrorCode(null)
      // Auto-activate the first model when none is set yet.
      if (!activeId) onPatch({ activeLive2dModelId: outcome.id })
    } else {
      setErrorCode(outcome.code)
    }
  }

  // Auto-activate the first imported model from the multi-select dialog when no
  // model is active yet (mirrors the single-import path).
  function handleImported(firstId?: string): void {
    if (firstId && !activeId) onPatch({ activeLive2dModelId: firstId })
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setBusy(true)
    setErrorCode(null)
    try {
      const parsed = await filesToEntries(files)
      if (!parsed.ok) {
        setErrorCode(parsed.code)
        return
      }
      // Discover every model in the bundle (folder or whole .zip), grouped per
      // model. 0 → no settings; 1 → keep the original direct import; >1 → let
      // the user choose which to import.
      const discovered = await discoverLive2dModels(parsed.entries)
      if (discovered.length === 0) {
        setErrorCode("noSettings")
        return
      }
      if (discovered.length === 1) {
        applyOutcome(await importModelFromEntries(discovered[0].entries, { source: "import" }))
        return
      }
      setImportModels(discovered)
    } finally {
      setBusy(false)
    }
  }

  async function handleDownload(id: string): Promise<void> {
    const entry = SAMPLE_MODEL_CATALOG.find((e) => e.id === id)
    if (!entry) return
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setErrorCode("downloadFailed")
      return
    }
    setDownloadingId(id)
    setErrorCode(null)
    try {
      applyOutcome(await downloadSampleModel(entry))
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    await deletePetModel(id)
    if (activeId === id) onPatch({ activeLive2dModelId: undefined })
  }

  return (
    <FieldGroup className="border-t pt-4">
      <Item size="sm" className="px-0">
        <ItemContent>
          <ItemTitle>{t("title")}</ItemTitle>
        </ItemContent>
        <ItemDescription className="ml-auto text-right">
          {t("storageUsage", { count: usage.models, size: formatBytes(usage.totalBytes) })}
        </ItemDescription>
      </Item>

      <PetSkinStatus
        requestedSkinId="live2d"
        effectiveSkinId={effectiveSkin}
        diagnostics={compatibilityDiagnostics}
        onConfigure={activeModel ? () => setConfigModelId(activeModel.id) : undefined}
      />

      {models.length === 0 ? (
        <Empty className="py-6">
          <EmptyDescription>{t("noModels")}</EmptyDescription>
        </Empty>
      ) : (
        <RadioGroup
          value={activeId}
          aria-label={t("title")}
          onValueChange={(id) => onPatch({ activeLive2dModelId: id })}
        >
          {models.map((m) => (
            <Item key={m.id} className="min-w-0 px-0">
              <ItemMedia>
                <RadioGroupItem
                  value={m.id}
                  aria-label={t("setActive")}
                  disabled={m.compatibility?.status === "invalid"}
                />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="max-w-full flex-wrap">
                  <span className="truncate">{m.name}</span>
                  {activeId === m.id && <Badge variant="secondary">{t("active")}</Badge>}
                  <Badge
                    variant="outline"
                    data-compatibility-status={m.compatibility?.status ?? "legacy"}
                  >
                    {t(`compatibility.status.${m.compatibility?.status ?? "legacy"}`)}
                  </Badge>
                </ItemTitle>
                {m.compatibility && m.compatibility.diagnostics.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {m.compatibility.diagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}:${diagnostic.path ?? index}`}>
                        {diagnostic.path
                          ? t("compatibility.diagnosticWithPath", {
                              message: t(`errors.${diagnostic.code}`),
                              path: diagnostic.path,
                            })
                          : t(`errors.${diagnostic.code}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </ItemContent>
              <ItemActions>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("configure")}
                  data-testid={`pet-model-configure-${m.id}`}
                  onClick={() => setConfigModelId(m.id)}
                >
                  <AnimatedActionIcon icon={AnimatedSettingsIcon} size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("delete")}
                  onClick={() => void handleDelete(m.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </ItemActions>
            </Item>
          ))}
        </RadioGroup>
      )}

      {configModel && (
        <PetModelConfigDialog
          // Keyed by model id so each editing session mounts fresh — the
          // dialog seeds its draft from the row at mount (no reseed effect).
          key={configModel.id}
          model={configModel}
          open
          onOpenChange={(open) => {
            if (!open) setConfigModelId(null)
          }}
        />
      )}

      {importModels && (
        <PetModelImportDialog
          models={importModels}
          open
          onOpenChange={(open) => {
            if (!open) setImportModels(null)
          }}
          onImported={handleImported}
        />
      )}

      <FieldDescription>{t("importHint")}</FieldDescription>

      <div className="flex flex-wrap gap-2">
        <Input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={IMPORT_ACCEPT}
          aria-label={t("import")}
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <Input
          ref={folderInputRef}
          type="file"
          className="hidden"
          aria-label={t("importFolder")}
          // @ts-expect-error — webkitdirectory is a non-standard but widely-supported attr.
          webkitdirectory=""
          multiple
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon className="size-4" /> {t("import")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => folderInputRef.current?.click()}
        >
          <FolderIcon className="size-4" /> {t("importFolder")}
        </Button>
      </div>

      <ItemGroup>
        {SAMPLE_MODEL_CATALOG.map((s) => (
          <Item key={s.id} size="sm" className="px-0">
            <ItemContent>
              <ItemTitle>{s.name}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || downloadingId !== null}
                onClick={() => void handleDownload(s.id)}
              >
                <DownloadIcon className="size-4" />
                {downloadingId === s.id ? t("downloading") : t("download")}
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>

      {errorCode && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${errorCode}`)}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  )
}
