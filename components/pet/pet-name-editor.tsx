// Inline rename affordance for a hatched pet. Shows the name with a pencil; the
// pencil swaps in a small input (Enter / blur saves, Escape cancels). Validation
// + persistence live in `renamePet`; this component is presentational and calls
// the injected `onRename`.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, PencilIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MAX_PET_NAME, isValidPetName, sanitizePetName } from "@/lib/pet/runtime/rename-pet"

export interface PetNameEditorProps {
  name: string
  onRename: (name: string) => void | Promise<void>
  className?: string
  /** Tailwind text-size class for the displayed name. */
  nameClassName?: string
}

export function PetNameEditor({ name, onRename, className, nameClassName }: PetNameEditorProps) {
  const t = useTranslations("pet.rename")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const open = () => {
    setDraft(name)
    setEditing(true)
  }

  const commit = () => {
    const next = sanitizePetName(draft)
    if (next && next !== name) void onRename(next)
    setEditing(false)
  }

  if (!editing) {
    return (
      <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
        <span className={cn("truncate font-semibold", nameClassName)}>{name}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label={t("edit")}
          onClick={open}
        >
          <PencilIcon className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      data-testid="pet-name-editor"
    >
      <Input
        autoFocus
        value={draft}
        maxLength={MAX_PET_NAME}
        aria-label={t("label")}
        className="h-8 w-40 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if (e.key === "Escape") setEditing(false)
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        aria-label={t("save")}
        disabled={!isValidPetName(draft)}
        onClick={commit}
      >
        <CheckIcon className="size-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 text-muted-foreground"
        aria-label={t("cancel")}
        onClick={() => setEditing(false)}
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  )
}
