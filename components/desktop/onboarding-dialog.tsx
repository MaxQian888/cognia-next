"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { listCharacters } from "@/lib/db/characters"
import type { Character } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings-store"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { avatarColor, avatarGlyph } from "@/lib/avatar"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPickCharacter: (character: Character) => void
}

/**
 * First-run wizard. Shown only when the API key is unset (the shell decides).
 *
 * Step 1 collects the API key (pushes to Rust + Dexie via `setApiKey`).
 * Step 2 lets the user pick a built-in character to chat with right now.
 *
 * The user can dismiss at any time; the wizard re-appears on next launch
 * until the API key is set.
 */
export function OnboardingDialog({ open, onOpenChange, onPickCharacter }: Props) {
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const settings = useSettingsStore((s) => s.settings)
  const characters = useLiveQuery<Character[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listCharacters()),
    []
  )

  const [step, setStep] = useState<1 | 2>(settings?.apiKey ? 2 : 1)
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim()
    if (!trimmed) {
      toast.error("Paste your Anthropic API key to continue.")
      return
    }
    setSaving(true)
    try {
      await setApiKey(trimmed)
      setStep(2)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {step === 1 ? "Welcome to Cognia" : "Pick a character to start"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {step === 1
              ? "Cognia talks to Claude on your behalf. Paste an Anthropic API key to begin — it's stored locally in your browser's IndexedDB and pushed to the embedded Node sidecar."
              : "Each character carries its own system prompt and tools. You can edit, duplicate, or create more later in Settings → Characters."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 1 ? (
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="onboarding-key" className="text-xs">
                Anthropic API key
              </Label>
              <Input
                id="onboarding-key"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-…"
                className="font-mono text-xs"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Get one at <code className="rounded bg-muted px-1">console.anthropic.com</code>. The
                key never leaves your machine.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Skip for now
              </Button>
              <Button size="sm" onClick={() => void handleSaveKey()} disabled={saving}>
                {saving ? "Saving…" : "Continue"}
                <ArrowRightIcon className="ml-1 size-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-2">
              {(characters ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onPickCharacter(c)
                    onOpenChange(false)
                  }}
                  className="flex items-start gap-2 rounded-md border p-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-sm"
                    style={{
                      backgroundColor: avatarColor(c),
                      color: "white",
                    }}
                    aria-hidden
                  >
                    {avatarGlyph(c)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.name}</p>
                    {c.description && (
                      <p className="line-clamp-2 text-[11px] text-muted-foreground">
                        {c.description}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
            <div className="flex justify-between gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep(1)}
                disabled={Boolean(settings?.apiKey)}
              >
                <ArrowLeftIcon className="mr-1 size-3.5" />
                Back
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                <CheckIcon className="mr-1 size-3.5" />
                Done
              </Button>
            </div>
          </div>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
