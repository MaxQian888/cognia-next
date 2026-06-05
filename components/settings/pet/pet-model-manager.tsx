// Settings → Pet → Live2D model manager. Lists installed models (live via
// useLiveQuery), lets the user set one active or delete it, imports from a folder
// or a .zip, downloads official sample models, and shows storage usage. The
// import/download/validation/persist logic lives in `pet-model-import.ts` so
// this component stays presentational and its test can mock those helpers.

"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Trash2Icon, UploadIcon, FolderIcon, DownloadIcon, SettingsIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  listPetModels,
  deletePetModel,
  getPetModelStorageUsage,
  type PetModelRow,
} from "@/lib/db/pet-models"
import { SAMPLE_MODEL_CATALOG } from "@/lib/pet/live2d/constants"
import { formatBytes } from "@/lib/agent/utils"
import type { PetSettings } from "@/types/pet"
import {
  filesToEntries,
  importModelFromEntries,
  downloadSampleModel,
  type ImportOutcome,
} from "./pet-model-import"
import { PetModelConfigDialog } from "./pet-model-config-dialog"

export interface PetModelManagerProps {
  settings: PetSettings
  onPatch: (patch: Partial<PetSettings>) => void
}

const IMPORT_ACCEPT = ".zip,.model3.json,.moc3,.png,.json"

export function PetModelManager({ settings, onPatch }: PetModelManagerProps) {
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

  const activeId = settings.activeLive2dModelId

  function applyOutcome(outcome: ImportOutcome): void {
    if (outcome.ok) {
      setErrorCode(null)
      // Auto-activate the first model when none is set yet.
      if (!activeId) onPatch({ activeLive2dModelId: outcome.id })
    } else {
      setErrorCode(outcome.code)
    }
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setBusy(true)
    setErrorCode(null)
    try {
      const entries = await filesToEntries(files)
      if (!entries.ok) {
        setErrorCode(entries.code)
        return
      }
      applyOutcome(await importModelFromEntries(entries.entries, { source: "import" }))
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
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-center justify-between gap-4">
        <Label>{t("title")}</Label>
        <span className="text-xs text-muted-foreground">
          {t("storageUsage", { count: usage.models, size: formatBytes(usage.totalBytes) })}
        </span>
      </div>

      {models.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noModels")}</p>
      ) : (
        <ul className="space-y-2">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="pet-live2d-active"
                  aria-label={t("setActive")}
                  checked={activeId === m.id}
                  onChange={() => onPatch({ activeLive2dModelId: m.id })}
                />
                <span className="text-sm">{m.name}</span>
                {activeId === m.id && (
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-xs">{t("active")}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("configure")}
                  data-testid={`pet-model-configure-${m.id}`}
                  onClick={() => setConfigModelId(m.id)}
                >
                  <SettingsIcon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("delete")}
                  onClick={() => void handleDelete(m.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
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

      <p className="text-xs text-muted-foreground">{t("importHint")}</p>

      <div className="flex flex-wrap gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={IMPORT_ACCEPT}
          aria-label={t("import")}
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <input
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

      <div className="space-y-2">
        {SAMPLE_MODEL_CATALOG.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2">
            <span className="text-sm">{s.name}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || downloadingId !== null}
              onClick={() => void handleDownload(s.id)}
            >
              <DownloadIcon className="size-4" />
              {downloadingId === s.id ? t("downloading") : t("download")}
            </Button>
          </div>
        ))}
      </div>

      {errorCode && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      )}
    </div>
  )
}
