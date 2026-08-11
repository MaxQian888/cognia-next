"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { SparklesIcon, Trash2Icon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Textarea } from "@/components/ui/textarea"
import {
  addPetSpritePack,
  deletePetSpritePack,
  listPetSpritePacks,
} from "@/lib/db/pet-sprite-packs"
import {
  validateSpriteV2Import,
  SpriteV2ImportError,
  type SpriteV2ImportErrorCode,
} from "@/lib/pet/sprite-v2/import"
import { seedMainChat } from "@/lib/pet/chat/seed-main-chat"
import { isTauri } from "@/lib/platform/detect"
import type { PetSettings } from "@/types/pet"

export interface PetSpritePackManagerProps {
  settings: PetSettings
  onPatch: (patch: Partial<PetSettings>) => void
}

export interface HatchPetPromptCopy {
  defaultConcept: string
  instruction: string
  concept: (brief: string) => string
  qa: string
  outputFiles: string
  scope: string
}

export function buildHatchPetPrompt(concept: string, copy: HatchPetPromptCopy): string {
  const brief = concept.trim() || copy.defaultConcept
  return [copy.instruction, copy.concept(brief), copy.qa, copy.outputFiles, copy.scope].join("\n")
}

async function readImageDimensions(image: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(image)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

type SpriteImportStatus = "idle" | "installed" | "incomplete" | "invalid" | SpriteV2ImportErrorCode

/** Terminal error status → its translated alert message key under `spriteV2`. */
const IMPORT_ERROR_KEY: Partial<Record<SpriteImportStatus, string>> = {
  incomplete: "error.incomplete",
  invalid: "error.invalid",
  "bad-manifest": "error.badManifest",
  "bad-format": "error.badFormat",
  "too-large": "error.tooLarge",
  "already-installed": "error.alreadyInstalled",
  "bad-dimensions": "error.badDimensions",
}

export function PetSpritePackManager({ settings, onPatch }: PetSpritePackManagerProps) {
  const t = useTranslations("settings.pet.spriteV2")
  const router = useRouter()
  const packs = useLiveQuery(() => listPetSpritePacks(), [], [])
  const [concept, setConcept] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<SpriteImportStatus>("idle")

  async function importFiles(files: FileList | File[]) {
    const selected = Array.from(files)
    const manifestFile = selected.find((file) => file.name.toLowerCase() === "pet.json")
    const spritesheet = selected.find((file) => /^spritesheet\.(?:png|webp)$/i.test(file.name))
    if (!manifestFile || !spritesheet) {
      setStatus("incomplete")
      return
    }

    setBusy(true)
    setStatus("idle")
    try {
      const manifest = JSON.parse(await manifestFile.text()) as unknown
      const payload = await validateSpriteV2Import({
        manifest,
        spritesheet,
        readImageDimensions,
        existingIds: packs.map((pack) => pack.id),
      })
      const installed = await addPetSpritePack(payload)
      onPatch({ skinId: "sprite-v2", activeSpritePackId: installed.id })
      setStatus("installed")
    } catch (error) {
      setStatus(error instanceof SpriteV2ImportError ? error.code : "invalid")
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    await deletePetSpritePack(id)
    if (settings.activeSpritePackId === id) {
      onPatch({ skinId: "svg", activeSpritePackId: undefined })
    }
  }

  async function openAgentTask() {
    setBusy(true)
    try {
      await seedMainChat(
        buildHatchPetPrompt(concept, {
          defaultConcept: t("agentPrompt.defaultConcept"),
          instruction: t("agentPrompt.instruction"),
          concept: (brief) => t("agentPrompt.concept", { concept: brief }),
          qa: t("agentPrompt.qa"),
          outputFiles: t("agentPrompt.outputFiles"),
          scope: t("agentPrompt.scope"),
        })
      )
      router.push("/")
    } finally {
      setBusy(false)
    }
  }

  const errorMessageKey = IMPORT_ERROR_KEY[status]

  return (
    <FieldGroup data-testid="pet-sprite-pack-manager">
      {isTauri() && (
        <Field>
          <FieldTitle className="gap-2">
            <SparklesIcon className="size-4" aria-hidden /> {t("createTitle")}
          </FieldTitle>
          <FieldDescription>{t("createDescription")}</FieldDescription>
          <FieldLabel htmlFor="pet-sprite-concept">{t("conceptLabel")}</FieldLabel>
          <Textarea
            id="pet-sprite-concept"
            value={concept}
            onChange={(event) => setConcept(event.target.value)}
            placeholder={t("conceptPlaceholder")}
            rows={3}
          />
          <Button type="button" size="sm" onClick={() => void openAgentTask()} disabled={busy}>
            {t("create")}
          </Button>
        </Field>
      )}

      <FieldSeparator />
      <Field>
        <FieldLabel htmlFor="pet-sprite-import">{t("import")}</FieldLabel>
        <Input
          id="pet-sprite-import"
          type="file"
          multiple
          accept="application/json,image/png,image/webp,.json,.png,.webp"
          disabled={busy}
          onChange={(event) => {
            if (event.currentTarget.files) void importFiles(event.currentTarget.files)
          }}
        />
        <FieldDescription>{t("importHint")}</FieldDescription>
        {status === "installed" ? (
          <Alert>
            <AlertDescription>{t("installed")}</AlertDescription>
          </Alert>
        ) : null}
        {errorMessageKey && (
          <Alert variant="destructive">
            <AlertDescription>{t(errorMessageKey)}</AlertDescription>
          </Alert>
        )}
      </Field>

      <FieldSeparator />
      <Field>
        {packs.length === 0 ? (
          <Empty className="py-6">
            <EmptyDescription>{t("empty")}</EmptyDescription>
          </Empty>
        ) : (
          <ItemGroup>
            {packs.map((pack) => {
              const active = settings.activeSpritePackId === pack.id
              return (
                <Item key={pack.id} className="min-w-0 px-0">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="max-w-full truncate">{pack.displayName}</ItemTitle>
                    {pack.description ? (
                      <ItemDescription>{pack.description}</ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions className="shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      variant={active ? "secondary" : "outline"}
                      onClick={() => onPatch({ skinId: "sprite-v2", activeSpritePackId: pack.id })}
                    >
                      {active ? t("active") : t("activate")}
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("delete", { name: pack.displayName })}
                      onClick={() => void remove(pack.id)}
                    >
                      <Trash2Icon className="size-4" aria-hidden />
                    </Button>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
      </Field>
    </FieldGroup>
  )
}
