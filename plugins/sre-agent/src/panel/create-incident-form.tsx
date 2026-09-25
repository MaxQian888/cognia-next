"use client"

import { useId, useState, type FormEvent } from "react"
import { Button, Input, Label } from "@cognia/plugin-ui"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"
import { TOUCH_BUTTON } from "./touch"

export interface CreateIncidentValues {
  title: string
  environment: string
}

/**
 * What a person types to open an incident: what is happening, and where.
 *
 * The title is required. An incident named after the panel ("SRE incidents")
 * is indistinguishable from every other one in the list, which is what the
 * one-click create used to produce.
 */
export function CreateIncidentForm({
  onSubmit,
  onCancel,
  defaultEnvironment = "prod",
}: {
  onSubmit: (values: CreateIncidentValues) => void
  onCancel: () => void
  defaultEnvironment?: string
}) {
  const t = usePluginTranslations(PLUGIN_ID)
  const titleId = useId()
  const environmentId = useId()
  const errorId = useId()
  const [title, setTitle] = useState("")
  const [environment, setEnvironment] = useState(defaultEnvironment)
  const [showError, setShowError] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) {
      setShowError(true)
      return
    }
    onSubmit({ title: trimmed, environment: environment.trim() || defaultEnvironment })
  }

  return (
    <form
      className="space-y-3 border-b p-3"
      onSubmit={submit}
      aria-labelledby={`${titleId}-heading`}
      data-testid="sre-create-form"
      noValidate
    >
      <h3 id={`${titleId}-heading`} className="text-xs font-medium">
        {t("create.heading")}
      </h3>
      <div className="space-y-1">
        <Label htmlFor={titleId} className="text-xs">
          {t("create.titleLabel")}
        </Label>
        <Input
          id={titleId}
          value={title}
          autoFocus
          placeholder={t("create.titlePlaceholder")}
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
          onChange={(event) => {
            setTitle(event.target.value)
            if (showError && event.target.value.trim()) setShowError(false)
          }}
          data-testid="sre-create-title"
        />
        {showError ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {t("create.titleRequired")}
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor={environmentId} className="text-xs">
          {t("create.environmentLabel")}
        </Label>
        <Input
          id={environmentId}
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
          data-testid="sre-create-environment"
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" className={TOUCH_BUTTON} onClick={onCancel}>
          {t("create.cancel")}
        </Button>
        <Button type="submit" size="sm" className={TOUCH_BUTTON} data-testid="sre-create-submit">
          {t("create.submit")}
        </Button>
      </div>
    </form>
  )
}
