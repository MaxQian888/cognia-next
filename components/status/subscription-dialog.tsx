"use client"

/**
 * Email signup for status updates (plan §10).
 *
 * - Primary page with email enabled: address, language, component scope
 *   (none checked = every component) and the consent text. A successful POST
 *   only means "if the address can be subscribed, a confirmation was sent";
 *   the dialog says that and never says "subscribed".
 * - Email unavailable (`capabilities.email === false`): the form is replaced
 *   by an explanation and the feeds stay the alternative.
 * - Mirror: read-only, so the dialog links to the primary page instead of
 *   posting. (Inside Cognia the Subscribe button opens the primary page in
 *   the browser and this dialog is not used.)
 *
 * Progress is announced with `role="status"`, failures with `role="alert"`.
 */

import { useId, useState, type FormEvent } from "react"
import { useLocale, useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useSubscribe } from "@/hooks/status/use-subscription-actions"
import {
  COMPONENT_IDS,
  normalizeStatusLocale,
  STATUS_LOCALES,
  type ComponentId,
  type StatusCapabilities,
  type StatusLocale,
  type StatusRuntime,
} from "@/lib/status/public-status"

import { StatusExternalLink } from "./status-link"

/** Deliberately loose: the server owns normalisation and validation. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SubscriptionPreferenceFields({
  locale,
  onLocaleChange,
  componentIds,
  onComponentIdsChange,
  locales,
  disabled,
}: {
  locale: StatusLocale
  onLocaleChange: (locale: StatusLocale) => void
  componentIds: readonly ComponentId[]
  onComponentIdsChange: (ids: ComponentId[]) => void
  locales: readonly StatusLocale[]
  disabled?: boolean
}) {
  const t = useTranslations("publicStatus")
  const baseId = useId()
  const toggle = (id: ComponentId, checked: boolean) => {
    const next = new Set(componentIds)
    if (checked) next.add(id)
    else next.delete(id)
    onComponentIdsChange(COMPONENT_IDS.filter((candidate) => next.has(candidate)))
  }
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${baseId}-locale`}>{t("subscribe.locale")}</Label>
        <NativeSelect
          id={`${baseId}-locale`}
          value={locale}
          disabled={disabled}
          onChange={(event) => onLocaleChange(normalizeStatusLocale(event.target.value))}
        >
          {locales.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {t(`locales.${option}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{t("subscribe.componentsLabel")}</legend>
        <p className="text-xs text-muted-foreground">{t("subscribe.componentsHint")}</p>
        {COMPONENT_IDS.map((id) => (
          <div key={id} className="flex items-center gap-2">
            <Checkbox
              id={`${baseId}-${id}`}
              checked={componentIds.includes(id)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(id, checked === true)}
            />
            <Label htmlFor={`${baseId}-${id}`} className="font-normal">
              {t(`components.${id}.name`)}
            </Label>
          </div>
        ))}
      </fieldset>
    </>
  )
}

export function SubscriptionDialog({
  open,
  onOpenChange,
  runtime,
  capabilities,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  runtime: StatusRuntime
  /** From the latest snapshot; null until one arrived. */
  capabilities: StatusCapabilities | null
}) {
  const t = useTranslations("publicStatus")
  const currentLocale = useLocale()
  const emailId = useId()
  const { state, submit, reset } = useSubscribe(runtime)
  const [email, setEmail] = useState("")
  const [emailError, setEmailError] = useState(false)
  const [locale, setLocale] = useState<StatusLocale>(() => normalizeStatusLocale(currentLocale))
  const [componentIds, setComponentIds] = useState<ComponentId[]>([])

  const mirror = runtime.mode === "mirror"
  const emailAvailable = runtime.allowsConsentWrites && capabilities?.email === true
  const locales = capabilities?.locales.length ? capabilities.locales : STATUS_LOCALES
  const submitting = state.phase === "submitting"

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      reset()
      setEmailError(false)
    }
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!EMAIL_SHAPE.test(email.trim())) {
      setEmailError(true)
      return
    }
    setEmailError(false)
    submit({ email, locale, componentIds })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} data-testid="subscription-dialog">
        <DialogHeader>
          <DialogTitle>{t("subscribe.title")}</DialogTitle>
          <DialogDescription>{t("subscribe.description")}</DialogDescription>
        </DialogHeader>

        {mirror ? (
          <div className="space-y-4 text-sm">
            <p>{t("subscribe.mirrorDescription")}</p>
            <StatusExternalLink
              href={runtime.primaryPageUrl}
              mode={runtime.mode}
              className="font-medium"
            >
              {t("subscribe.openPrimary")}
            </StatusExternalLink>
          </div>
        ) : !emailAvailable ? (
          <p className="text-sm" role="status" data-testid="subscription-disabled">
            {t("subscribe.disabled")}
          </p>
        ) : state.phase === "pending" ? (
          <div
            role="status"
            className="space-y-2 rounded-lg border p-4"
            data-testid="subscription-pending"
          >
            <p className="font-medium">{t("subscribe.pendingTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("subscribe.pending")}</p>
          </div>
        ) : (
          <form
            className="space-y-5"
            onSubmit={onSubmit}
            noValidate
            aria-busy={submitting || undefined}
          >
            <div className="space-y-2">
              <Label htmlFor={emailId}>{t("subscribe.email")}</Label>
              <Input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                value={email}
                disabled={submitting}
                aria-invalid={emailError || undefined}
                aria-describedby={emailError ? `${emailId}-error` : undefined}
                placeholder={t("subscribe.emailPlaceholder")}
                onChange={(event) => setEmail(event.target.value)}
              />
              {emailError ? (
                <p
                  id={`${emailId}-error`}
                  role="alert"
                  className="text-xs text-rose-700 dark:text-rose-300"
                >
                  {t("subscribe.emailInvalid")}
                </p>
              ) : null}
            </div>
            <SubscriptionPreferenceFields
              locale={locale}
              onLocaleChange={setLocale}
              componentIds={componentIds}
              onComponentIdsChange={setComponentIds}
              locales={locales}
              disabled={submitting}
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("subscribe.consent")}</p>
            {submitting ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("subscribe.submitting")}
              </p>
            ) : null}
            {state.phase === "error" ? (
              <p
                role="alert"
                className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-200"
                data-testid="subscription-error"
                data-kind={state.kind}
              >
                {t(`subscribe.errors.${subscribeErrorKey(state.kind)}`)}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t("actions.close")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t("subscribe.submitting") : t("subscribe.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {mirror || !emailAvailable || state.phase === "pending" ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t("actions.close")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Signup errors have no token kinds; anything token-shaped is a bad request. */
function subscribeErrorKey(
  kind: string
): "bad_request" | "forbidden" | "invalid" | "network" | "rate_limited" | "unavailable" {
  switch (kind) {
    case "forbidden":
    case "invalid":
    case "network":
    case "rate_limited":
    case "unavailable":
      return kind
    default:
      return "bad_request"
  }
}
