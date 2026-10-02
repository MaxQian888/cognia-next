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
import {
  BellOffIcon,
  CheckCircle2Icon,
  MailCheckIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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

import { IconTile, type IconTone } from "./status-labels"
import { SubscriptionPreferenceFields } from "./subscription-dialog"
import { StatusExternalLink } from "./status-link"
import { formatList } from "./status-format"

function PreferencesSummary({ preferences }: { preferences: SubscriptionPreferences }) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  return (
    <dl
      className="grid grid-cols-[auto_1fr] divide-y rounded-xl border text-sm [&>*]:py-2.5"
      data-testid="token-preferences"
    >
      <dt className="pl-4 text-muted-foreground">{t("token.preferences.address")}</dt>
      <dd className="!border-t-0 pr-4 pl-4 font-medium break-all">{preferences.maskedEmail}</dd>
      <dt className="pl-4 text-muted-foreground">{t("token.preferences.locale")}</dt>
      <dd className="pr-4 pl-4">{t(`locales.${preferences.locale}`)}</dd>
      <dt className="pl-4 text-muted-foreground">{t("token.preferences.components")}</dt>
      <dd className="pr-4 pl-4">
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
      <p className="rounded-xl bg-muted/50 px-3.5 py-2.5 text-sm font-medium break-all">
        {preferences.maskedEmail}
      </p>
      <SubscriptionPreferenceFields
        locale={locale}
        onLocaleChange={setLocale}
        componentIds={componentIds}
        onComponentIdsChange={setComponentIds}
        locales={STATUS_LOCALES}
        disabled={saving}
      />
      <Button type="submit" className="w-full" disabled={saving}>
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

  const icon: { icon: typeof MailCheckIcon; tone: IconTone } =
    action === "confirm"
      ? { icon: MailCheckIcon, tone: "neutral" }
      : action === "manage"
        ? { icon: SlidersHorizontalIcon, tone: "neutral" }
        : action === "unsubscribe"
          ? { icon: BellOffIcon, tone: "neutral" }
          : { icon: TriangleAlertIcon, tone: "warning" }

  /** A finished action: check mark and the outcome sentence. */
  const done = (text: string) => (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
      <CheckCircle2Icon
        className="size-5 shrink-0 text-emerald-700 dark:text-emerald-300"
        aria-hidden
      />
      <p role="status" className="text-sm font-medium" data-testid="token-done">
        {text}
      </p>
    </div>
  )

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
          className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3.5 text-sm text-rose-800 dark:text-rose-200"
          data-testid="token-error"
          data-kind={state.kind}
        >
          {t(`token.errors.${state.kind}`)}
        </p>
      )
    } else if (state.phase === "working") {
      body = (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
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
          {done(t("token.confirm.done"))}
          <PreferencesSummary preferences={state.preferences} />
        </div>
      )
    } else if (state.phase === "unsubscribed") {
      body = done(t("token.unsubscribe.done"))
    } else if (state.phase === "preferences") {
      body = (
        <div className="space-y-4">
          {state.notice === "saved" ? (
            <p
              role="status"
              className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3.5 py-2.5 text-sm font-medium"
              data-testid="token-saved"
            >
              <CheckCircle2Icon
                className="size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                aria-hidden
              />
              {t("token.manage.saved")}
            </p>
          ) : null}
          {state.notice === "conflict" ? (
            <p
              role="alert"
              className="rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300"
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
      body = (
        <Button size="lg" className="w-full" onClick={token.confirm}>
          {t("token.confirm.action")}
        </Button>
      )
    } else if (action === "unsubscribe") {
      body = (
        <Button variant="destructive" size="lg" className="w-full" onClick={token.unsubscribe}>
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
      <DialogContent
        showCloseButton={false}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        data-testid="token-dialog"
      >
        <DialogHeader className="gap-3">
          <IconTile icon={icon.icon} tone={icon.tone} size="lg" className="mx-auto sm:mx-0" />
          <div className="space-y-1.5">
            <DialogTitle className="text-xl">{title}</DialogTitle>
            <DialogDescription className="leading-6">{description}</DialogDescription>
          </div>
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
