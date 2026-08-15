"use client"

/**
 * OAuthLoginButton - Quick login button for providers that support OAuth
 * Currently supports: OpenRouter (PKCE flow)
 *
 * Host-aware end to end:
 *  - desktop / mobile shells: the IdP redirects to the `cognia://provider/oauth/<id>`
 *    deep link, delivered by the Tauri deep-link plugin / Capacitor `appUrlOpen`
 *    (same plumbing as `ConnectorDeepLinkRouter`); the authorize page opens in
 *    the system browser / in-app browser sheet;
 *  - web: the IdP redirects back to this settings route with `?oauthProvider=<id>&code=…`,
 *    parsed on mount.
 * The code is exchanged straight against the provider's token endpoint (there
 * is no `/api/*` in the static export).
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { LogIn, Loader2, Check, AlertCircle, Unlink } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  buildNativeOAuthRedirectUri,
  buildOAuthUrl,
  clearOAuthState,
  exchangeCodeForApiKey,
  getOAuthCallbackQueryKeys,
  getOAuthState,
  parseNativeOAuthDeepLink,
  parseOAuthCallback,
  verifyOAuthState,
} from "@cognia/provider-core/providers/oauth"
import { useSettingsStore } from "@/stores"
import { PROVIDERS } from "@cognia/provider-types"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { openUrl } from "@/lib/native/opener"
import { getLaunchDeepLink, onDeepLink } from "@/lib/tauri/deep-link"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import {
  getLaunchRoute as getCapacitorLaunchRoute,
  subscribe as subscribeCapacitorDeeplink,
} from "@/lib/capacitor/deeplink"
import { close as closeCapacitorBrowser } from "@/lib/capacitor/browser"

/** Query param the web callback route carries so only the matching button acts. */
const WEB_CALLBACK_PROVIDER_PARAM = "oauthProvider"

interface OAuthLoginButtonProps {
  providerId: string
  onSuccess?: (apiKey: string) => void
  onError?: (error: string) => void
  variant?: "default" | "outline" | "secondary"
  size?: "default" | "sm" | "lg" | "icon"
  className?: string
  /**
   * Web-only full-page navigation to the authorize URL. Defaults to
   * `window.location.href = url`; injectable because jsdom cannot navigate.
   */
  navigate?: (url: string) => void
}

export function OAuthLoginButton({
  providerId,
  onSuccess: _onSuccess,
  onError: _onError,
  variant = "outline",
  size = "sm",
  className,
  navigate,
}: OAuthLoginButtonProps) {
  const t = useTranslations("providers")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    const update = () => setNow(Date.now())
    const interval = setInterval(update, 60_000)
    return () => clearInterval(interval)
  }, [])

  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const updateProviderSettings = useSettingsStore((state) => state.updateProviderSettings)

  const provider = PROVIDERS[providerId]
  const settings = providerSettings[providerId]
  const isConnected = settings?.oauthConnected && settings?.apiKey

  // Check if OAuth token is expired
  const isExpired = settings?.oauthExpiresAt && settings.oauthExpiresAt < now
  const isExpiringSoon =
    settings?.oauthExpiresAt &&
    settings.oauthExpiresAt > now &&
    settings.oauthExpiresAt < now + 24 * 60 * 60 * 1000 // expires within 24 hours

  /**
   * Finish the flow with the code the IdP handed back — shared by the web
   * query-string path and the native deep-link path.
   */
  const completeWithCode = useCallback(
    async (oauthCode: string, oauthState: string | null | undefined) => {
      setIsLoading(true)
      setError(null)
      try {
        const storedState = getOAuthState()
        if (!storedState || storedState.providerId !== providerId) {
          throw new Error(t("oauthStateMismatch"))
        }
        if (oauthState && !verifyOAuthState(oauthState)) {
          throw new Error(t("oauthStateMismatch"))
        }

        const data = await exchangeCodeForApiKey(providerId, {
          code: oauthCode,
          codeVerifier: storedState.codeVerifier,
        })
        if (!data?.apiKey) {
          throw new Error(t("oauthExchangeFailed"))
        }

        updateProviderSettings(providerId, {
          apiKey: data.apiKey,
          enabled: true,
          oauthConnected: true,
          oauthExpiresAt: data.expiresAt,
        })

        clearOAuthState()
      } catch (err) {
        setError(err instanceof Error ? err.message : t("oauthFailed"))
      } finally {
        setIsLoading(false)
      }
    },
    [providerId, t, updateProviderSettings]
  )
  const completeWithCodeRef = useRef(completeWithCode)
  useEffect(() => {
    completeWithCodeRef.current = completeWithCode
  }, [completeWithCode])

  // Web: check for OAuth callback parameters on mount. Only the button whose
  // provider the callback names acts — every OAuth-capable provider mounts
  // one of these.
  useEffect(() => {
    if (isTauri() || isCapacitor()) return
    const params = new URLSearchParams(window.location.search)
    const target = params.get(WEB_CALLBACK_PROVIDER_PARAM)
    if (target && target !== providerId) return
    const callback = parseOAuthCallback(providerId, params)
    if (!callback) return

    const oauthCode = callback.code
    const oauthError = callback.error
    const oauthState = callback.state

    if (!oauthCode && !oauthError) {
      return
    }

    const url = new URL(window.location.href)
    for (const key of [...getOAuthCallbackQueryKeys(providerId), WEB_CALLBACK_PROVIDER_PARAM]) {
      url.searchParams.delete(key)
    }
    window.history.replaceState({}, "", `${url.pathname}${url.search}`)

    if (oauthError) {
      const message = oauthError === "no_code" ? t("oauthNoCode") : oauthError
      setTimeout(() => setError(message), 0)
      clearOAuthState()
      return
    }

    if (oauthCode) {
      void completeWithCodeRef.current(oauthCode, oauthState)
    }
  }, [providerId, t])

  // Native shells: listen for `cognia://provider/oauth/<id>?code=…` while the
  // button is mounted (live path) and replay a cold-start launch URL once.
  useEffect(() => {
    if (!isTauri() && !isCapacitor()) return
    let cancelled = false
    const seen = new Set<string>()
    const dispatch = (raw: string) => {
      const parsed = parseNativeOAuthDeepLink(raw)
      if (!parsed || parsed.providerId !== providerId || seen.has(raw)) return
      seen.add(raw)
      const code = parsed.search.get("code")
      const errorParam = parsed.search.get("error")
      if (isCapacitor()) void closeCapacitorBrowser()
      if (errorParam) {
        setError(errorParam === "no_code" ? t("oauthNoCode") : errorParam)
        clearOAuthState()
        return
      }
      if (code) void completeWithCodeRef.current(code, parsed.search.get("state"))
    }

    if (isTauri()) {
      let unlisten: (() => void) | null = null
      void (async () => {
        const launch = await getLaunchDeepLink()
        if (!cancelled && launch) for (const url of launch) dispatch(url)
        unlisten = await onDeepLink((urls) => {
          for (const url of urls) dispatch(url)
        })
        if (cancelled && unlisten) {
          safeUnlisten(unlisten)
          unlisten = null
        }
      })()
      return () => {
        cancelled = true
        safeUnlisten(unlisten)
      }
    }

    let unsub: (() => void) | null = null
    void (async () => {
      const u = await subscribeCapacitorDeeplink((route) => dispatch(route.raw))
      if (cancelled) {
        u()
        return
      }
      unsub = u
      const launch = await getCapacitorLaunchRoute()
      if (launch && !cancelled) dispatch(launch.raw)
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [providerId, t])

  const handleLogin = useCallback(async () => {
    if (!provider?.supportsOAuth) return

    setIsLoading(true)
    setError(null)

    try {
      const native = isTauri() || isCapacitor()
      const result = await buildOAuthUrl(providerId, {
        // Native shells cannot receive a browser redirect on their
        // `tauri://` / `capacitor://` origin — the IdP sends the user back
        // through the registered `cognia://` scheme instead.
        redirectUri: native ? buildNativeOAuthRedirectUri(providerId) : undefined,
      })
      if (!result) {
        throw new Error(t("oauthBuildUrlFailed"))
      }

      if (native) {
        // System browser (desktop) / in-app browser sheet (mobile); the
        // deep-link listener above finishes the flow, so the button just
        // stops spinning once the page is open.
        await openUrl(result.url)
        setIsLoading(false)
        return
      }
      // Web: full-page redirect; the callback lands back on this route.
      if (navigate) navigate(result.url)
      else window.location.href = result.url
    } catch (err) {
      const message = err instanceof Error ? err.message : t("oauthStartFailed")
      setError(message)
      setIsLoading(false)
    }
  }, [providerId, provider, t, navigate])

  const handleDisconnect = useCallback(() => {
    updateProviderSettings(providerId, {
      apiKey: "",
      oauthConnected: false,
      oauthExpiresAt: undefined,
    })
  }, [providerId, updateProviderSettings])

  if (!provider?.supportsOAuth) return null

  // Show re-login prompt if token is expired
  if (isConnected && isExpired) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size={size}
              onClick={handleLogin}
              disabled={isLoading}
              className={cn("border-amber-500 text-amber-600 hover:bg-amber-50", className)}
            >
              <AlertCircle className="h-4 w-4 mr-1 text-amber-500" />
              {t("oauthExpired")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("oauthExpiredHint")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (isConnected) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size={size} onClick={handleDisconnect} className={className}>
              {isExpiringSoon ? (
                <AlertCircle className="h-4 w-4 mr-1 text-amber-500" />
              ) : (
                <Check className="h-4 w-4 mr-1 text-green-500" />
              )}
              {t("oauthConnected")}
              <Unlink className="h-3 w-3 ml-1 opacity-50" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isExpiringSoon ? t("oauthExpiringSoonHint") : t("oauthDisconnectHint")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={variant}
              size={size}
              onClick={handleLogin}
              disabled={isLoading}
              className={className}
              data-testid="oauth-button"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : error ? (
                <AlertCircle className="h-4 w-4 mr-1 text-destructive" />
              ) : (
                <LogIn className="h-4 w-4 mr-1" />
              )}
              {t("oauthLogin")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("oauthLoginHint", { provider: provider.name })}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Failures used to live only in the hover tooltip, so a denied consent
          or a failed exchange looked like nothing happened. */}
      {error ? (
        <p className="text-xs text-destructive" role="alert" data-testid="oauth-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
