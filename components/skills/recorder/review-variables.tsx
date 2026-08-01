"use client"

/**
 * Deciding what varies between runs.
 *
 * Every suggestion arrives unconfirmed and blocks generation until answered.
 * That is deliberate friction: the recorder cannot tell a search term from a
 * menu name, and guessing wrong produces either a skill hard-coded to one
 * person's data or one with a placeholder where a fixed value belonged.
 *
 * The recorded sample is shown so the choice is informed, and labelled as
 * staying on this device — because it does. It is excluded from the model
 * payload and from the saved skill unless the user picks "always this value".
 */

import { useTranslations } from "next-intl"
import { Check } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { InputVariable, InputVariableKind } from "@/lib/skills/recording/input-variables"

interface Props {
  variables: readonly InputVariable[]
  onConfirm: (seq: number, patch: { name?: string; kind?: InputVariableKind }) => void
}

export function ReviewVariables({ variables, onConfirm }: Props) {
  const t = useTranslations("skills.recorder.review.variables")
  if (variables.length === 0) return null

  const unconfirmed = variables.filter((v) => !v.confirmed).length

  return (
    <section className="space-y-2 rounded-lg border p-3">
      <header className="space-y-0.5">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        {unconfirmed > 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t("unconfirmed", { count: unconfirmed })}
          </p>
        ) : null}
      </header>

      <ul className="space-y-2">
        {variables.map((variable) => (
          <li key={variable.seq} className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-40"
              value={variable.name}
              aria-label={t("name")}
              onChange={(event) => onConfirm(variable.seq, { name: event.target.value })}
            />
            <Select
              value={variable.kind}
              onValueChange={(kind) => onConfirm(variable.seq, { kind: kind as InputVariableKind })}
            >
              <SelectTrigger className="h-8 w-48" aria-label={variable.name}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="variable">{t("kindVariable")}</SelectItem>
                <SelectItem value="literal">{t("kindLiteral")}</SelectItem>
                <SelectItem value="sensitive">{t("kindSensitive")}</SelectItem>
              </SelectContent>
            </Select>

            {variable.sample ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {t("sample")}: <code className="font-mono">{variable.sample}</code>
                <span className="ml-1 opacity-70">({t("sampleLocal")})</span>
              </span>
            ) : null}

            {variable.confirmed ? (
              <Badge variant="secondary" className="gap-1">
                <Check className="size-3" aria-hidden />
                {t("confirmed")}
              </Badge>
            ) : (
              <Button size="sm" variant="outline" onClick={() => onConfirm(variable.seq, {})}>
                {t("confirm")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
