"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemTitle, ItemGroup } from "@/components/ui/item"
import { addPetMediaPack, deletePetMediaPack, listPetMediaPacks } from "@/lib/db/pet-media-packs"
import {
  extractMediaPackZip,
  importMediaPack,
  MediaPackImportError,
  type MediaPackImportErrorCode,
} from "@/lib/pet/media-packs/import"
import { prepareMediaPackForDesktop } from "@/lib/pet/media-packs/prepare"
import type { PetSettings } from "@/types/pet"

export function PetMediaPackManager({
  settings,
  onPatch,
}: {
  settings: PetSettings
  onPatch(patch: Partial<PetSettings>): void
}) {
  const t = useTranslations("settings.pet.mediaPack")
  const packs = useLiveQuery(() => listPetMediaPacks(), [], [])
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState<"installed" | MediaPackImportErrorCode>()
  async function install(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    setStatus(undefined)
    try {
      const selected = Array.from(files)
      const entries =
        selected.length === 1 && /\.zip$/i.test(selected[0].name)
          ? await extractMediaPackZip(selected[0])
          : selected.map((file) => ({ path: file.webkitRelativePath || file.name, blob: file }))
      const asset = await prepareMediaPackForDesktop(await importMediaPack(entries))
      await addPetMediaPack(asset)
      onPatch({ skinId: "media", activeMediaPackId: asset.id })
      setStatus("installed")
    } catch (error) {
      setStatus(error instanceof MediaPackImportError ? error.code : "invalid")
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: string) {
    try {
      await deletePetMediaPack(id)
      if (settings.activeMediaPackId === id)
        onPatch({
          ...(settings.skinId === "media" ? { skinId: "svg" as const } : {}),
          activeMediaPackId: undefined,
        })
    } catch {
      setStatus("invalid")
    }
  }
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="pet-media-zip">{t("importZip")}</FieldLabel>
        <Input
          id="pet-media-zip"
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(event) => {
            void install(event.currentTarget.files)
            event.currentTarget.value = ""
          }}
        />
        <FieldLabel htmlFor="pet-media-folder">{t("importFolder")}</FieldLabel>
        <Input
          id="pet-media-folder"
          type="file"
          multiple
          {...{ webkitdirectory: "" }}
          disabled={busy}
          onChange={(event) => {
            void install(event.currentTarget.files)
            event.currentTarget.value = ""
          }}
        />
        <FieldDescription>{busy ? t("importing") : t("hint")}</FieldDescription>
        {status && (
          <Alert variant={status === "installed" ? "default" : "destructive"}>
            <AlertDescription>
              {status === "installed" ? t("installed") : t(`errors.${status}`)}
            </AlertDescription>
          </Alert>
        )}
      </Field>
      {!packs.length && <FieldDescription>{t("empty")}</FieldDescription>}
      <ItemGroup>
        {packs.map((pack) => (
          <Item key={pack.id} className="px-0">
            <ItemContent>
              <ItemTitle>{pack.displayName}</ItemTitle>
              <FieldDescription>
                {t("details", {
                  count: Object.keys(pack.manifest.clips).length,
                  size: (pack.totalBytes / 1024 / 1024).toFixed(1),
                })}
              </FieldDescription>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                size="sm"
                disabled={
                  busy || (settings.skinId === "media" && settings.activeMediaPackId === pack.id)
                }
                onClick={() => onPatch({ skinId: "media", activeMediaPackId: pack.id })}
              >
                {settings.skinId === "media" && settings.activeMediaPackId === pack.id
                  ? t("active")
                  : t("activate")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={t("deleteNamed", { name: pack.displayName })}
                onClick={() => void remove(pack.id)}
              >
                {t("delete")}
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </FieldGroup>
  )
}
