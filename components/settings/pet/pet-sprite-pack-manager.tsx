"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { SparklesIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  addPetSpritePack,
  deletePetSpritePack,
  listPetSpritePacks,
} from "@/lib/db/pet-sprite-packs"
import { validateSpriteV2Import } from "@/lib/pet/sprite-v2/import"
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

export function PetSpritePackManager({ settings, onPatch }: PetSpritePackManagerProps) {
  const t = useTranslations("settings.pet.spriteV2")
  const router = useRouter()
  const packs = useLiveQuery(() => listPetSpritePacks(), [], [])
  const [concept, setConcept] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<"idle" | "installed" | "invalid">("idle")

  async function importFiles(files: FileList | File[]) {
    const selected = Array.from(files)
    const manifestFile = selected.find((file) => file.name.toLowerCase() === "pet.json")
    const spritesheet = selected.find((file) => /^spritesheet\.(?:png|webp)$/i.test(file.name))
    if (!manifestFile || !spritesheet) {
      setStatus("invalid")
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
    } catch {
      setStatus("invalid")
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

  return (
    <div className="space-y-4" data-testid="pet-sprite-pack-manager">
      {isTauri() && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <SparklesIcon className="size-4" aria-hidden />
            {t("createTitle")}
          </div>
          <p className="text-xs text-muted-foreground">{t("createDescription")}</p>
          <Label htmlFor="pet-sprite-concept">{t("conceptLabel")}</Label>
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
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="pet-sprite-import">{t("import")}</Label>
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
        <p className="text-xs text-muted-foreground">{t("importHint")}</p>
        {status === "installed" && <p className="text-sm text-emerald-600">{t("installed")}</p>}
        {status === "invalid" && (
          <p className="text-sm text-destructive" role="alert">
            {t("invalid")}
          </p>
        )}
      </div>

      <div className="space-y-2">
        {packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          packs.map((pack) => {
            const active = settings.activeSpritePackId === pack.id
            return (
              <div
                key={pack.id}
                className="flex items-center justify-between gap-3 rounded-md border p-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{pack.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{pack.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
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
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
