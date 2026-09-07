"use client"

// Guided paste-a-key login for a built-in provider.
//
// Most providers publish no OAuth client, so pasting a key IS the sanctioned
// login. Until now that was an unlabelled password field: nothing said where a
// key comes from, and nothing checked that the pasted value works. A wrong key
// then surfaced at the first chat turn as an opaque provider error, far from
// the field that caused it.
//
// This adds the two things that make it a real login. "Get a key" opens the
// provider's own console page, and "Verify" runs the cheapest call that proves
// the provider accepts the key.
//
// The console link is worded from how precisely it was resolved. A coding-plan
// relay that names no console of its own inherits the page of the vendor it is
// a deployment of, and when even that is missing it lands on the vendor's
// platform page. That last one is a correct place to start and not a key page,
// so it says so rather than promising a key it cannot point at.
//
// The verify result is deliberately three-way. "Could not verify" is a
// different answer from "wrong key", because being offline or being rate
// limited says nothing about the key, and reporting either one as the other is
// how a working key gets thrown away or a typo gets accepted.

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ExternalLink, Loader2, ShieldQuestion, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { openUrl } from "@/lib/native/opener"
import { cn } from "@/lib/utils"
import {
  resolveKeyLogin,
  validateProviderApiKey,
  type ApiKeyValidationResult,
} from "@cognia/provider-core/providers/api-key-login"

export interface KeyLoginRowProps {
  providerId: string
  /** The key currently saved for this provider, if any. */
  apiKey?: string
  /** Test seam. Defaults to the real probe. */
  validate?: typeof validateProviderApiKey
}

/**
 * Renders nothing for a provider with neither a console page nor a probe, so
 * mounting it for every built-in is safe.
 */
export function KeyLoginRow({ providerId, apiKey, validate }: KeyLoginRowProps) {
  const t = useTranslations("providers.keyLogin")
  const [result, setResult] = useState<ApiKeyValidationResult | null>(null)
  const [checking, setChecking] = useState(false)

  const login = resolveKeyLogin(providerId)
  const runValidate = validate ?? validateProviderApiKey

  const onVerify = useCallback(async () => {
    if (!apiKey) return
    setChecking(true)
    setResult(null)
    try {
      setResult(await runValidate(providerId, apiKey))
    } finally {
      setChecking(false)
    }
  }, [apiKey, providerId, runValidate])

  if (!login) return null

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="key-login-row">
      {login.authUrl ? (
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void openUrl(login.authUrl as string)}
          data-testid="key-login-open-console"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {login.authUrlSource === "website" ? t("openConsole") : t("getKey")}
        </Button>
      ) : null}

      {login.validate ? (
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void onVerify()}
          disabled={!apiKey || checking}
          data-testid="key-login-verify"
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {t("verify")}
        </Button>
      ) : null}

      {result ? <KeyLoginVerdict result={result} /> : null}
    </div>
  )
}

function KeyLoginVerdict({ result }: { result: ApiKeyValidationResult }) {
  const t = useTranslations("providers.keyLogin")

  const tone =
    result.status === "valid"
      ? "text-emerald-600 dark:text-emerald-400"
      : result.status === "invalid"
        ? "text-destructive"
        : "text-muted-foreground"

  const Icon =
    result.status === "valid" ? Check : result.status === "invalid" ? TriangleAlert : ShieldQuestion

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs", tone)}
      data-testid={`key-login-${result.status}`}
      // The detail is the provider's own words. It is the only thing that
      // explains WHY a key was refused, so it is surfaced rather than dropped.
      title={result.status === "valid" ? undefined : result.message}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {result.status === "valid"
        ? t("valid")
        : result.status === "invalid"
          ? t("invalid")
          : t("unverified")}
    </span>
  )
}

export default KeyLoginRow
