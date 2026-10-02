"use client"

/**
 * Landing dialog for the links in subscription emails
 * (`/status/#action=confirm|manage|unsubscribe&token=…`).
 *
 * The page has already cleared the fragment from the address bar. On the
 * primary page:
 * - confirm: an explicit "Confirm subscription" press posts the token, then
 *   the confirmed preferences are shown;
 * - manage: the current preferences are read (no change) and can be edited;
 *   a revision conflict reloads them and says so;
 * - unsubscribe: an explicit "Unsubscribe" press posts the token.
 * Expired, used and malformed links are explained without detail about the
 * address. A mirror never posts and links to the primary page; inside Cognia
 * the link is handed to the browser on the official page.
 */

import { useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { TokenActionState } from "@/hooks/status/use-subscription-actions"
import {
  STATUS_LOCALES,
  statusTokenPageUrl,
  type ComponentId,
  type StatusLocale,
  type StatusRuntime,
  type SubscriptionPreferences,
} from "@/lib/status/public-status"
import { openExternal } from "@/lib/tauri/opener"

import { SubscriptionPreferenceFields } from "./subscription-dialog"
import { StatusExternalLink } from "./status-link"
import { formatList } from "./status-format"

function PreferencesSummary({ preferences }: { preferences: SubscriptionPreferences }) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-4 text-sm"
      data-testid="token-preferences"
    >
      <dt className="text-muted-foreground">{t("token.preferences.address")}</dt>
      <dd className="break-all">{preferences.maskedEmail}</dd>
      <dt className="text-muted-foreground">{t("token.preferences.locale")}</dt>
      <dd>{t(`locales.${preferences.locale}`)}</dd>
      <dt className="text-muted-foreground">{t("token.preferences.components")}</dt>
      <dd>
        {preferences.componentIds.length === 0
          ? t("token.allComponents")
          : formatList(
              preferences.componentIds.map((id) => t(`components.${id}.name`)),
              locale
            )}
      </dd>
    </dl>
  )
}

function ManageForm({
  preferences,
  saving,
  onSave,
}: {
  preferences: SubscriptionPreferences
  saving: boolean
  onSave: (input: { locale: StatusLocale; componentIds: ComponentId[] }) => void
}) {
  const t = useTranslations("publicStatus")
  // Keyed by revision in the parent, so a reload after a conflict resets it.
  const [locale, setLocale] = useState<StatusLocale>(preferences.locale)
  const [componentIds, setComponentIds] = useState<ComponentId[]>(preferences.componentIds)
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ locale, componentIds })
      }}
    >
      <p className="text-sm">{preferences.maskedEmail}</p>
      <SubscriptionPreferenceFields
        locale={locale}
        onLocaleChange={setLocale}
        componentIds={componentIds}
        onComponentIdsChange={setComponentIds}
        locales={STATUS_LOCALES}
        disabled={saving}
      />
      <Button type="submit" disabled={saving}>
        {saving ? t("token.manage.saving") : t("token.manage.save")}
      </Button>
    </form>
  )
}

export function TokenActionDialog({
  runtime,
  token,
}: {
  runtime: StatusRuntime
  token: TokenActionState
}) {
  const t = useTranslations("publicStatus")
  const { fragment, state } = token
  if (!fragment) return null

  const open = !token.dismissed
  const action = fragment.kind === "valid" ? fragment.action : null
  const title =
    action === "confirm"
      ? t("token.confirm.title")
      : action === "manage"
        ? t("token.manage.title")
        : action === "unsubscribe"
          ? t("token.unsubscribe.title")
          : t("token.malformedTitle")
  const description =
    action === "confirm"
      ? t("token.confirm.description")
      : action === "manage"
        ? t("token.manage.description")
        : action === "unsubscribe"
          ? t("token.unsubscribe.description")
          : t("token.malformed")

  let body: ReactNode = null
  if (fragment.kind === "valid" && !runtime.allowsConsentWrites) {
    const primaryUrl = statusTokenPageUrl(runtime.primaryPageUrl, fragment.action, fragment.token)
    body =
      runtime.mode === "app" ? (
        <div className="space-y-4 text-sm">
          <p>{t("token.app")}</p>
          <Button onClick={() => void openExternal(primaryUrl)}>{t("token.appContinue")}</Button>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p>{t("token.mirror")}</p>
          <StatusExternalLink href={primaryUrl} mode={runtime.mode} className="font-medium">
            {t("token.mirrorOpen")}
          </StatusExternalLink>
        </div>
      )
  } else if (fragment.kind === "valid") {
    if (state.phase === "error") {
      body = (
        <p
          role="alert"
          className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-200"
          data-testid="token-error"
          data-kind={state.kind}
        >
          {t(`token.errors.${state.kind}`)}
        </p>
      )
    } else if (state.phase === "working") {
      body = (
        <p role="status" className="text-sm text-muted-foreground">
          {action === "manage"
            ? t("token.manage.loading")
            : action === "unsubscribe"
              ? t("token.unsubscribe.working")
              : t("token.working")}
        </p>
      )
    } else if (state.phase === "confirmed") {
      body = (
        <div className="space-y-3">
          <p role="status" className="text-sm font-medium" data-testid="token-done">
            {t("token.confirm.done")}
          </p>
          <PreferencesSummary preferences={state.preferences} />
        </div>
      )
    } else if (state.phase === "unsubscribed") {
      body = (
        <p role="status" className="text-sm font-medium" data-testid="token-done">
          {t("token.unsubscribe.done")}
        </p>
      )
    } else if (state.phase === "preferences") {
      body = (
        <div className="space-y-4">
          {state.notice === "saved" ? (
            <p role="status" className="text-sm font-medium" data-testid="token-saved">
              {t("token.manage.saved")}
            </p>
          ) : null}
          {state.notice === "conflict" ? (
            <p
              role="alert"
              className="text-sm text-amber-800 dark:text-amber-300"
              data-testid="token-conflict"
            >
              {t("token.manage.conflict")}
            </p>
          ) : null}
          {state.saveError ? (
            <p
              role="alert"
              className="text-sm text-rose-700 dark:text-rose-300"
              data-testid="token-save-error"
            >
              {t(`token.errors.${state.saveError}`)}
            </p>
          ) : null}
          <ManageForm
            key={state.preferences.revision}
            preferences={state.preferences}
            saving={state.saving}
            onSave={token.savePreferences}
          />
        </div>
      )
    } else if (action === "confirm") {
      body = <Button onClick={token.confirm}>{t("token.confirm.action")}</Button>
    } else if (action === "unsubscribe") {
      body = (
        <Button variant="destructive" onClick={token.unsubscribe}>
          {t("token.unsubscribe.action")}
        </Button>
      )
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) token.dismiss()
      }}
    >
      <DialogContent showCloseButton={false} data-testid="token-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button variant="outline" onClick={token.dismiss}>
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
