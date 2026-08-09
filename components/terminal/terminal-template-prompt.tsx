"use client"

/**
 * Dialog that prompts the user to fill template variables before
 * executing a parameterized command.
 *
 * Renders an input field for each `input` variable and a select
 * dropdown for each `select` variable. Auto-resolvable variables
 * (env, cwd, clipboard, date) are resolved silently and not shown.
 *
 * The parent opens this dialog when `hasInteractiveVars(template)`
 * returns true, and receives the filled values on submit.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TemplateVariable } from "@/lib/terminal/template-engine"

export interface TerminalTemplatePromptProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The interactive variables that need user input. */
  variables: TemplateVariable[]
  /** Called when the user submits. Values keyed by `variable.raw`. */
  onSubmit: (values: Record<string, string>) => void
  /** The raw template string — shown in description for context. */
  template?: string
}

export function TerminalTemplatePrompt({
  open,
  onOpenChange,
  variables,
  onSubmit,
  template,
}: TerminalTemplatePromptProps) {
  const t = useTranslations("terminal.template")
  const initialValues = React.useMemo(() => {
    const initial: Record<string, string> = {}
    for (const v of variables) {
      if (v.kind === "input" && v.defaultValue !== undefined) {
        initial[v.raw] = v.defaultValue
      } else if (v.kind === "select" && v.options && v.options.length > 0) {
        initial[v.raw] = v.options[0]
      } else {
        initial[v.raw] = ""
      }
    }
    return initial
  }, [variables])
  const [state, setState] = React.useState({ variables, values: initialValues })

  if (state.variables !== variables) {
    setState({ variables, values: initialValues })
  }

  const setValues = React.useCallback(
    (update: React.SetStateAction<Record<string, string>>) => {
      setState((current) => ({
        ...current,
        values: typeof update === "function" ? update(current.values) : update,
      }))
    },
    []
  )
  const values = state.values

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(values)
    onOpenChange(false)
  }

  const interactiveVars = variables.filter((v) => v.kind === "input" || v.kind === "select")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="template-prompt-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          {template && (
            <DialogDescription className="font-mono text-xs">{template}</DialogDescription>
          )}
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-2">
          {interactiveVars.map((v) => (
            <div key={v.raw} className="flex flex-col gap-1.5">
              <Label htmlFor={`tmpl-${v.raw}`} className="text-sm font-medium">
                {v.label}
              </Label>
              {v.kind === "input" ? (
                <Input
                  id={`tmpl-${v.raw}`}
                  data-testid={`template-input-${v.label}`}
                  value={values[v.raw] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [v.raw]: e.target.value }))}
                  placeholder={v.defaultValue ?? t("inputPlaceholder")}
                  autoFocus={interactiveVars[0] === v}
                />
              ) : (
                <Select
                  value={values[v.raw] ?? ""}
                  onValueChange={(val) => setValues((prev) => ({ ...prev, [v.raw]: val }))}
                >
                  <SelectTrigger id={`tmpl-${v.raw}`} data-testid={`template-select-${v.label}`}>
                    <SelectValue placeholder={t("selectPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(v.options ?? []).map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ))}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="template-cancel"
            >
              {t("cancel")}
            </Button>
            <Button type="submit" data-testid="template-submit">
              {t("run")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default TerminalTemplatePrompt
