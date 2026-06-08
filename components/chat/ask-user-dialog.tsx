"use client"

// Renders the active `ask_user` prompt as a modal. Mounted once at the app
// layout; it subscribes to `useAskUserStore` and resolves the pending tool
// call when the user submits or dismisses. One prompt at a time (the store
// queues concurrent calls).

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { useAskUserStore } from "@/stores/agent/ask-user-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"

export function AskUserDialog() {
  const t = useTranslations("chat.askUser")
  const active = useAskUserStore((s) => s.active)
  const resolveActive = useAskUserStore((s) => s.resolveActive)

  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState("")

  // Reset the form whenever a new prompt becomes active — the render-time
  // derived-state-reset pattern (setState-in-effect is disallowed here).
  const activeId = active?.id
  const [prevActiveId, setPrevActiveId] = useState(activeId)
  if (activeId !== prevActiveId) {
    setPrevActiveId(activeId)
    setSelected([])
    setText("")
  }

  const request = active?.request
  const canSubmit = useMemo(() => {
    if (!request) return false
    if (selected.length > 0) return true
    if (request.allowText) return text.trim().length > 0
    return false
  }, [request, selected, text])

  if (!request) return null

  const submit = () => {
    if (!canSubmit) return
    resolveActive({ selected, text, cancelled: false })
  }

  const dismiss = () => resolveActive({ selected: [], text: "", cancelled: true })

  const toggleMulti = (value: string, checked: boolean) =>
    setSelected((prev) => (checked ? [...prev, value] : prev.filter((v) => v !== value)))

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="max-w-md" data-testid="ask-user-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-foreground">
            {request.question}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {request.options.length > 0 &&
            (request.multiSelect ? (
              <div className="space-y-2" role="group" aria-label={t("title")}>
                {request.options.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.includes(o.value)}
                      onCheckedChange={(c) => toggleMulti(o.value, c === true)}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            ) : (
              <RadioGroup
                value={selected[0] ?? ""}
                onValueChange={(v) => setSelected([v])}
                className="space-y-2"
              >
                {request.options.map((o) => (
                  <div key={o.value} className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value={o.value} id={`ask-${o.value}`} />
                    <Label htmlFor={`ask-${o.value}`} className="font-normal">
                      {o.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            ))}

          {request.allowText && (
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("textPlaceholder")}
              rows={3}
              aria-label={t("textPlaceholder")}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>
            {t("dismiss")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
