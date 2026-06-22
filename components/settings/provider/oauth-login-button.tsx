"use client"

/**
 * OAuthLoginButton - Quick login button for providers that support OAuth
 * Currently supports: OpenRouter (PKCE flow)
 */

import { useState, useEffect, useCallback } from "react"
import { LogIn, Loader2, Check, AlertCircle, Unlink } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  buildOAuthUrl,
  clearOAuthState,
  exchangeCodeForApiKey,
  getOAuthCallbackQueryKeys,
  getOAuthState,
  parseOAuthCallback,
  verifyOAuthState,
} from "@cognia/provider-core/providers/oauth"
import { useSettingsStore } from "@/stores"
import { PROVIDERS } from "@cognia/provider-types"
import { cn } from "@/lib/utils"

interface OAuthLoginButtonProps {
  providerId: string
  onSuccess?: (apiKey: string) => void
  onError?: (error: string) => void
  variant?: "default" | "outline" | "secondary"
  size?: "default" | "sm" | "lg" | "icon"
  className?: string
}

export function OAuthLoginButton({
  providerId,
  onSuccess: _onSuccess,
  onError: _onError,
  variant = "outline",
  size = "sm",
  className,
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

  // Check for OAuth callback parameters on mount
  useEffect(() => {
    const callback = parseOAuthCallback(providerId, window.location.search)
    if (!callback) return

    const oauthCode = callback.code
    const oauthError = callback.error
    const oauthState = callback.state

    if (!oauthCode && !oauthError) {
      return
    }

    const url = new URL(window.location.href)
    for (const key of getOAuthCallbackQueryKeys(providerId)) {
      url.searchParams.delete(key)
    }
    window.history.replaceState({}, "", `${url.pathname}${url.search}`)

    if (oauthError) {
      const message = oauthError === "no_code" ? "No authorization code received" : oauthError
      setTimeout(() => setError(message), 0)
      clearOAuthState()
      return
    }

    if (oauthCode) {
      ;(async () => {
        setIsLoading(true)
        setError(null)

        try {
          const storedState = getOAuthState()
          if (!storedState || storedState.providerId !== providerId) {
            throw new Error("OAuth state mismatch")
          }

          if (oauthState && !verifyOAuthState(oauthState)) {
            throw new Error("OAuth state mismatch")
          }

          const data = await exchangeCodeForApiKey(providerId, {
            code: oauthCode,
            codeVerifier: storedState.codeVerifier,
          })
          if (!data?.apiKey) {
            throw new Error("Failed to exchange code")
          }

          updateProviderSettings(providerId, {
            apiKey: data.apiKey,
            enabled: true,
            oauthConnected: true,
            oauthExpiresAt: data.expiresAt,
          })

          clearOAuthState()
        } catch (err) {
          const message = err instanceof Error ? err.message : "OAuth failed"
          setError(message)
        } finally {
          setIsLoading(false)
        }
      })()
    }
  }, [providerId, updateProviderSettings])

  const handleLogin = useCallback(async () => {
    if (!provider?.supportsOAuth) return

    setIsLoading(true)
    setError(null)

    try {
      const result = await buildOAuthUrl(providerId)
      if (!result) {
        throw new Error("Failed to build OAuth URL")
      }

      // Redirect to OAuth provider
      window.location.href = result.url
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start OAuth"
      setError(message)
      setIsLoading(false)
    }
  }, [providerId, provider])

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
              {t("oauthExpired") || "Token Expired"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("oauthExpiredHint") || "Your OAuth token has expired. Click to re-authenticate."}
          </TooltipContent>
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
            {isExpiringSoon
              ? t("oauthExpiringSoonHint") || "Token expires soon. Consider re-authenticating."
              : t("oauthDisconnectHint")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size={size}
            onClick={handleLogin}
            disabled={isLoading}
            className={className}
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
        <TooltipContent>{error || t("oauthLoginHint", { provider: provider.name })}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
