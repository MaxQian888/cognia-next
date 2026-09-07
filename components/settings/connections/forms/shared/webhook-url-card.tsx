"use client"

/**
 * The inbound callback URL a platform console has to be given, and the reason
 * there is not one yet.
 *
 * Five adapter forms had grown their own copy of this block. They agreed on
 * the layout and drifted on the state machine, and the drift is what broke
 * cloud installs: each one gated the URL behind the cloudflared tunnel being
 * up, so a correctly configured headless deployment that had already derived
 * a working `https://host/connectors/webhook/...` address rendered the
 * desktop's "go start a tunnel" advice instead of the URL.
 *
 * Copy stays per platform, because it genuinely differs. Lark calls it a
 * Callback URL, Slack a Request URL, and each console needs its own
 * instructions. The form passes its own translation namespace and this card
 * resolves the shared key names inside it, so the words remain the platform's
 * while the branching is written once.
 *
 * `useTranslations` on a runtime namespace is invisible to `lint:i18n`, so
 * `webhook-url-card.catalogue.test.ts` reads the real message files and pins
 * that every namespace this card is mounted with carries the full key set, in
 * both locales.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ExternalLinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Surface } from "@/components/surface/surface"
import type { ConnectorIngress } from "@/hooks/use-connector-ingress"

/** Key names every consuming namespace must define. Pinned by the catalogue test. */
export const WEBHOOK_URL_CARD_KEYS = [
  "webhookUrlLabel",
  "webhookUrlHelp",
  "webhookUrlCopy",
  "webhookUrlCopyAria",
  "webhookUrlNewAdapterHint",
  "webhookUrlTunnelLoading",
  "webhookUrlTunnelOffHelp",
  "webhookUrlOriginMissingHelp",
  "webhookUrlUnsupportedHelp",
  "openCompanion",
  "openCompanionAria",
] as const

export interface WebhookUrlCardProps {
  /** Resolved ingress for whichever host this page runs on. */
  ingress: ConnectorIngress
  /**
   * `/webhook/<type>/<id>`, or null while the adapter has no id yet. A new
   * adapter genuinely has no URL, which is a different empty state from an
   * unreachable host and gets its own copy.
   */
  webhookPath: string | null
  /** Translation namespace of the owning form, e.g. `settings.connections.lark`. */
  namespace: string
  /** Prefix for the `data-testid` attributes, e.g. `lark`. */
  testIdPrefix: string
  onCopy: (url: string) => void
  /** Platform console deep link. Omitted for platforms that have no console page. */
  consoleUrl?: string
  /**
   * Key names inside `namespace` for the console link. The Aria key is
   * rendered as a `title` rather than an `aria-label`: these buttons carry
   * visible text, and an `aria-label` naming a different destination replaces
   * that text as the accessible name, which breaks WCAG 2.5.3 Label in Name
   * and stops a screen reader user and a sighted user from referring to the
   * same control by the same words.
   */
  consoleLabelKey?: string
  consoleAriaKey?: string
}

export function WebhookUrlCard({
  ingress,
  webhookPath,
  namespace,
  testIdPrefix,
  onCopy,
  consoleUrl,
  consoleLabelKey = "openConsole",
  consoleAriaKey = "openConsoleAria",
}: WebhookUrlCardProps) {
  const t = useTranslations(namespace)
  const router = useRouter()

  const url = webhookPath && ingress.base ? `${ingress.base}${webhookPath}` : null

  return (
    <Surface
      layer="raised"
      radius="control"
      className="space-y-2 border px-3 py-3"
      data-testid={`${testIdPrefix}-webhook-url-card`}
    >
      <Label className="text-xs font-medium">{t("webhookUrlLabel")}</Label>

      {webhookPath === null ? (
        <p className="text-xs text-muted-foreground">{t("webhookUrlNewAdapterHint")}</p>
      ) : ingress.loading ? (
        <p className="text-xs text-muted-foreground">{t("webhookUrlTunnelLoading")}</p>
      ) : url ? (
        <div className="space-y-2">
          <Input
            readOnly
            value={url}
            className="font-mono text-[11px]"
            data-testid={`${testIdPrefix}-webhook-url-input`}
            aria-label={t("webhookUrlLabel")}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onCopy(url)}
              aria-label={t("webhookUrlCopyAria")}
              data-testid={`${testIdPrefix}-webhook-url-copy`}
            >
              {t("webhookUrlCopy")}
            </Button>
            {consoleUrl ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.open(consoleUrl, "_blank", "noopener,noreferrer")
                  }
                }}
                title={t(consoleAriaKey)}
                data-testid={`${testIdPrefix}-open-console`}
              >
                <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
                {t(consoleLabelKey)}
              </Button>
            ) : null}
          </div>
          <p className="text-[10px] text-muted-foreground">{t("webhookUrlHelp")}</p>
        </div>
      ) : ingress.reason === "tunnel-off" ? (
        <div className="space-y-2">
          <p
            className="text-xs text-amber-700 dark:text-amber-400"
            data-testid={`${testIdPrefix}-webhook-url-tunnel-off`}
          >
            {t("webhookUrlTunnelOffHelp")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => router.push("/settings?section=connections&connectionsTab=tunnel")}
            title={t("openCompanionAria")}
            data-testid={`${testIdPrefix}-open-companion`}
          >
            {t("openCompanion")}
          </Button>
        </div>
      ) : ingress.reason === "unsupported" ? (
        // A browser with no host behind it. There is no tunnel to start and no
        // origin to configure, so offering either remedy would be a dead end.
        <p
          className="text-xs text-amber-700 dark:text-amber-400"
          data-testid={`${testIdPrefix}-webhook-url-unsupported`}
        >
          {t("webhookUrlUnsupportedHelp")}
        </p>
      ) : (
        // A cloud install has no tunnel and needs none. Pointing it at the
        // tunnel settings was advice for the wrong host.
        <p
          className="text-xs text-amber-700 dark:text-amber-400"
          data-testid={`${testIdPrefix}-webhook-url-origin-missing`}
        >
          {t("webhookUrlOriginMissingHelp")}
        </p>
      )}
    </Surface>
  )
}
