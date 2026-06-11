"use client"

// Renders the active `ask_user` prompt as a modal. Mounted once at the app
// layout; it subscribes to `useAskUserStore` and resolves the pending tool
// call when the user submits or dismisses. One prompt at a time (the store
// queues concurrent calls).

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageCircleQuestion } from "lucide-react"

import { cn } from "@/lib/utils"
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
  const queuedCount = useAskUserStore((s) => s.queue.length)
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

  const multi = request.multiSelect

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent
        className="max-w-md"
        data-testid="ask-user-dialog"
        // ⌘/Ctrl+Enter submits from anywhere in the dialog (incl. the textarea).
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleQuestion className="size-5 shrink-0 text-primary" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="mt-1 whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">
            {request.question}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {request.options.length > 0 && (
            <div className="space-y-2">
              {multi && <p className="text-xs text-muted-foreground">{t("multiHint")}</p>}
              {multi ? (
                <div className="space-y-1" role="group" aria-label={t("title")}>
                  {request.options.map((o) => {
                    const checked = selected.includes(o.value)
                    return (
                      <label
                        key={o.value}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                          checked ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(c) => toggleMulti(o.value, c === true)}
                        />
                        <span>{o.label}</span>
                      </label>
                    )
                  })}
                </div>
              ) : (
                <RadioGroup
                  value={selected[0] ?? ""}
                  onValueChange={(v) => setSelected([v])}
                  className="space-y-1"
                >
                  {request.options.map((o) => {
                    const checked = selected[0] === o.value
                    return (
                      <Label
                        key={o.value}
                        htmlFor={`ask-${o.value}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-normal transition-colors",
                          checked ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                        )}
                      >
                        <RadioGroupItem value={o.value} id={`ask-${o.value}`} />
                        {o.label}
                      </Label>
                    )
                  })}
                </RadioGroup>
              )}
            </div>
          )}

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

        <DialogFooter className="sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {queuedCount > 0 ? t("queued", { count: queuedCount }) : t("submitHint")}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={dismiss}>
              {t("dismiss")}
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {t("submit")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
