"use client"

// Guided parameter form for slash commands that declare `params`. Picking such
// a command opens this dialog instead of inserting raw text; on confirm it
// builds the args string (`buildArgs`) and hands it back so the composer can
// splice a `/command <args>` chip into the input. Keeps users from hand-typing
// flags like `--provider auto --lang en`.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { buildArgs, firstMissingRequired } from "@/lib/slash-commands/build-args"
import type { SlashCommand, SlashParamSpec } from "@/lib/slash-commands/builtin"

interface CommandParamFormProps {
  /** Command to configure; non-null with params → dialog is open. */
  command: SlashCommand | null
  /** Called with the built args string when the user confirms. */
  onSubmit: (args: string) => void
  /** Called when the user cancels / dismisses. */
  onCancel: () => void
}

function seedDefaults(params: SlashParamSpec[]): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const p of params) seed[p.name] = p.default ?? ""
  return seed
}

/** Inner body — remounted via `key={command.name}` so state seeds cleanly. */
function ParamFormBody({
  command,
  onSubmit,
  onCancel,
}: {
  command: SlashCommand
  onSubmit: (args: string) => void
  onCancel: () => void
}) {
  const t = useTranslations("chat.composer.paramForm")
  const params = command.params ?? []
  const [values, setValues] = useState<Record<string, string>>(() => seedDefaults(params))
  const [error, setError] = useState<string | null>(null)

  const setField = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }))

  const handleInsert = () => {
    const missing = firstMissingRequired(params, values)
    if (missing) {
      setError(t("missingRequired", { label: missing.label }))
      return
    }
    onSubmit(buildArgs(params, values))
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t("title", { name: command.name })}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-1">
        {params.map((p) => {
          const id = `param-${p.name}`
          return (
            <div key={p.name} className="space-y-1.5">
              <Label htmlFor={id} className="flex items-center gap-1.5">
                {p.label}
                {p.required && (
                  <span className="text-xs font-normal text-muted-foreground">
                    ({t("requiredMark")})
                  </span>
                )}
              </Label>
              {p.type === "enum" ? (
                <Select value={values[p.name] ?? ""} onValueChange={(v) => setField(p.name, v)}>
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={t("selectPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(p.options ?? []).map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : p.type === "boolean" ? (
                <div className="flex items-center">
                  <Switch
                    id={id}
                    checked={values[p.name] === "true"}
                    onCheckedChange={(c) => setField(p.name, c ? "true" : "")}
                  />
                </div>
              ) : (
                <Input
                  id={id}
                  type={p.type === "number" ? "number" : "text"}
                  value={values[p.name] ?? ""}
                  placeholder={p.placeholder}
                  onChange={(e) => setField(p.name, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleInsert()
                    }
                  }}
                />
              )}
            </div>
          )
        })}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" type="button" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="button" onClick={handleInsert}>
          {t("insert")}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function CommandParamForm({ command, onSubmit, onCancel }: CommandParamFormProps) {
  const open = !!command && (command.params?.length ?? 0) > 0
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      {command && open && (
        <ParamFormBody
          key={command.name}
          command={command}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    </Dialog>
  )
}
