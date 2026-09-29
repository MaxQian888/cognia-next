"use client"

import { KeyRoundIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import { browserClient } from "@/lib/browser/client"
import { localBrowser } from "@/lib/browser/local-client"
import {
  fillCredential,
  matchCredentials,
  type CredentialFillReason,
  type CredentialMeta,
} from "@/lib/browser/passwords"

type MatchedCredential = CredentialMeta

/**
 * When to look for a login form after the page URL changes. Pages render their
 * forms at different times after navigation, so detection is retried a few
 * times; the first hit wins and later attempts are skipped.
 */
export const LOGIN_DETECT_DELAYS_MS = [400, 1500, 4000] as const

const FILL_REASONS: readonly CredentialFillReason[] = ["no_match", "ambiguous", "no_login_form"]

/** Only these backends can fill a form without the value reaching the renderer. */
export function autofillTarget(backend: BrowserBackend): "embedded" | "local" | null {
  if (backend === "embedded") return "embedded"
  if (backend === "local-chromium" || backend === "user-chrome") return "local"
  return null
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

function hasLoginForms(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const forms = (value as { forms?: unknown }).forms
  return Array.isArray(forms) && forms.length > 0
}

async function detectLoginForm(
  target: "embedded" | "local",
  sessionId: string | undefined,
  pageId: string | undefined
): Promise<boolean> {
  if (target === "embedded") {
    const envelope = await browserClient.embedEvaluate(
      "typeof window.__cogniaDetectLogin === 'function' ? window.__cogniaDetectLogin() : null"
    )
    return envelope.ok && hasLoginForms(envelope.value)
  }
  if (!sessionId) return false
  const result = await localBrowser.rpc<unknown>("browser.forms.detect-login", {
    sessionId,
    ...(pageId ? { pageId } : {}),
  })
  return hasLoginForms(result)
}

type PromptState = {
  url: string
  matches: MatchedCredential[]
  selectedId: string
  closed: boolean
}

/**
 * Offers a saved credential when the page shows a login form (ADR-0201).
 *
 * Detection runs in the page (embedded overlay `__cogniaDetectLogin` or the
 * local runtime's `browser.forms.detect-login`), matching credentials come
 * from Rust by registrable domain as metadata only, and the fill itself is a
 * Rust call — the password never passes through this component. The cloud
 * browser and the web fallback have no Rust-side fill path, so on those
 * backends the prompt renders nothing.
 */
export function BrowserAutofillPrompt({
  backend,
  sessionId,
  pageId,
  url,
}: {
  backend: BrowserBackend
  /** Local runtime session; required for `local-chromium` / `user-chrome`. */
  sessionId?: string
  /** Local runtime page (tab); the session's active page when omitted. */
  pageId?: string
  /** The URL the page is showing. Detection restarts whenever it changes. */
  url: string
}) {
  const t = useTranslations("browserVault.autofill")
  const target = autofillTarget(backend)
  const [state, setState] = useState<PromptState | null>(null)
  const [filling, setFilling] = useState(false)

  useEffect(() => {
    if (!target || !isHttpUrl(url)) return
    if (target === "local" && !sessionId) return
    let cancelled = false
    let found = false
    const attempt = async () => {
      if (cancelled || found) return
      try {
        if (!(await detectLoginForm(target, sessionId, pageId))) return
        if (cancelled || found) return
        found = true
        const matches = await matchCredentials(url)
        if (cancelled || matches.length === 0) return
        setState({ url, matches, selectedId: matches[0].id, closed: false })
      } catch {
        // Detection is best-effort: a page mid-navigation or without the
        // helper simply gets no prompt. The next attempt may still succeed.
      }
    }
    const timers = LOGIN_DETECT_DELAYS_MS.map((delay) => setTimeout(() => void attempt(), delay))
    return () => {
      cancelled = true
      for (const timer of timers) clearTimeout(timer)
    }
  }, [target, sessionId, pageId, url])

  // State from an earlier URL is stale the moment the page moves on.
  const current = state && state.url === url && !state.closed ? state : null
  if (!target || !current) return null

  const close = () => setState((previous) => (previous ? { ...previous, closed: true } : previous))

  const fill = async () => {
    if (filling) return
    setFilling(true)
    try {
      const result = await fillCredential({
        target,
        ...(sessionId ? { sessionId } : {}),
        ...(pageId ? { pageId } : {}),
        credentialId: current.selectedId,
        url,
      })
      if (result.filled) {
        const username =
          result.username ??
          current.matches.find((match) => match.id === current.selectedId)?.username ??
          ""
        toast.success(t("filled", { username }))
        close()
      } else {
        const reason = FILL_REASONS.find((candidate) => candidate === result.reason)
        toast.error(reason ? t(`reason.${reason}`) : t("failed"))
      }
    } catch {
      toast.error(t("failed"))
    } finally {
      setFilling(false)
    }
  }

  return (
    <div
      role="region"
      aria-label={t("region")}
      className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm"
    >
      <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("title")}</p>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      {current.matches.length > 1 ? (
        <NativeSelect
          aria-label={t("account")}
          value={current.selectedId}
          onChange={(event) =>
            setState((previous) =>
              previous ? { ...previous, selectedId: event.target.value } : previous
            )
          }
        >
          {current.matches.map((match) => (
            <NativeSelectOption key={match.id} value={match.id}>
              {match.username}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <span className="truncate text-muted-foreground">{current.matches[0]?.username}</span>
      )}
      <Button size="sm" disabled={filling} onClick={() => void fill()}>
        {filling ? t("filling") : t("fill")}
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={t("dismiss")} onClick={close}>
        <XIcon />
      </Button>
    </div>
  )
}
