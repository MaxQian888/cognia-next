"use client"

import { type FormEvent, useCallback, useEffect, useState } from "react"
import { GlobeIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { isTauri, transport } from "@/lib/tauri"

/**
 * Mirrors Rust `companion_api::commands::BrowserAccessSummary`.
 *
 * `port` is what is saved; `boundPort` is what is listening right now. They are
 * separate fields because the difference is the whole state the user needs:
 * configured-but-not-listening is what "restart to apply" looks like, and it is
 * indistinguishable from working if you only show one number.
 */
export interface BrowserAccessSummary {
  enabled: boolean
  allowedOrigins: string[]
  port: number
  boundPort: number | null
  suggestedOrigins: string[]
  browserBaseUrl: string | null
  primaryOrigin: string | null
}

export interface BrowserAccessCardProps {
  /** Test seam — defaults to the real `companion_browser_access_get`. */
  load?: () => Promise<BrowserAccessSummary>
  /** Test seam — defaults to the real `companion_browser_access_set`. */
  save?: (input: {
    enabled: boolean
    allowedOrigins: string[]
    port: number
  }) => Promise<BrowserAccessSummary>
}

const defaultLoad = () => transport.call<BrowserAccessSummary>("companion_browser_access_get", {})

const defaultSave = (input: { enabled: boolean; allowedOrigins: string[]; port: number }) =>
  transport.call<BrowserAccessSummary>("companion_browser_access_set", input)

/**
 * Browser access — the plaintext, loopback-only listener a browser tab needs.
 *
 * A browser cannot pin this Host's self-signed certificate, so the HTTPS
 * listener every mobile client uses is unreachable from a tab. `http://127.0.0.1`
 * needs no chain at all, which makes this listener the browser's only door. It
 * is off by default because plaintext on loopback is readable by any other
 * process on the machine — this widens exposure, not authority, but it is a
 * real widening.
 *
 * Both halves are one decision on purpose: enabling the listener without naming
 * an origin binds a port that answers `403 web_origin_forbidden` to every
 * request a browser makes, which from the outside looks exactly like a port that
 * is not open.
 */
export function BrowserAccessCard({
  load = defaultLoad,
  save = defaultSave,
}: BrowserAccessCardProps) {
  const t = useTranslations("mobile.companion.browserAccess")
  const [summary, setSummary] = useState<BrowserAccessSummary | null>(null)
  const [origin, setOrigin] = useState("")
  // Two error channels on purpose. A load failure is ours to name (there is no
  // host message worth showing), so it is held as a flag and translated at
  // render; a save failure carries the host's own refusal text, which is the
  // part the user has to act on.
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void load()
      .then((next) => {
        if (!cancelled) setSummary(next)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
    // `t` is deliberately absent: next-intl hands back a fresh function on some
    // renders, and depending on it re-ran this effect after every save — which
    // reloaded the old config straight over the one that had just been written.
  }, [load])

  const apply = useCallback(
    async (next: { enabled: boolean; allowedOrigins: string[]; port: number }) => {
      setBusy(true)
      try {
        setError(null)
        setSummary(await save(next))
      } catch (err) {
        // The Rust side refuses an origin that is not an exact http(s) browser
        // origin, and refuses to enable with an empty list. Both are the user's
        // to fix, so the message is surfaced rather than swallowed.
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [save]
  )

  if (!isTauri() || !summary) return null

  const { enabled, allowedOrigins, port, boundPort, suggestedOrigins, browserBaseUrl } = summary
  const listening = boundPort !== null
  const restartRequired = enabled && allowedOrigins.length > 0 && !listening
  const unlistedSuggestions = suggestedOrigins.filter((s) => !allowedOrigins.includes(s))

  const addOrigin = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = origin.trim()
    if (!trimmed) return
    await apply({ enabled, allowedOrigins: [...allowedOrigins, trimmed], port })
    setOrigin("")
  }

  return (
    <Card data-testid="browser-access-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              <GlobeIcon className="size-4" aria-hidden="true" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            aria-label={t("enable")}
            onCheckedChange={(checked) => void apply({ enabled: checked, allowedOrigins, port })}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {listening ? (
            <Badge variant="secondary" data-testid="browser-access-listening">
              {t("listening", { url: browserBaseUrl ?? `http://127.0.0.1:${boundPort}` })}
            </Badge>
          ) : (
            <Badge variant="outline" data-testid="browser-access-idle">
              {t("notListening")}
            </Badge>
          )}
          {restartRequired ? (
            <span className="text-xs text-muted-foreground" data-testid="browser-access-restart">
              {t("restartRequired")}
            </span>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("origins.title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("origins.description")}</p>
          {allowedOrigins.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="browser-access-no-origins">
              {t("origins.empty")}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2" data-testid="browser-access-origins">
              {allowedOrigins.map((value) => (
                <li key={value}>
                  <Badge variant="secondary" className="gap-1 font-mono text-[11px]">
                    {value}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-4"
                      disabled={busy}
                      aria-label={t("origins.revoke", { origin: value })}
                      onClick={() =>
                        void apply({
                          enabled,
                          allowedOrigins: allowedOrigins.filter((o) => o !== value),
                          port,
                        })
                      }
                    >
                      <XIcon className="size-3" aria-hidden="true" />
                    </Button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <form className="flex gap-2" onSubmit={(event) => void addOrigin(event)}>
            <Input
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder={t("origins.placeholder")}
              aria-label={t("origins.add")}
              className="h-8 font-mono text-xs"
              disabled={busy}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !origin.trim()}>
              {t("origins.add")}
            </Button>
          </form>
          {unlistedSuggestions.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1.5"
              data-testid="browser-access-suggested"
            >
              <span className="text-xs text-muted-foreground">{t("origins.suggested")}</span>
              {unlistedSuggestions.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 font-mono text-[11px]"
                  disabled={busy}
                  onClick={() =>
                    void apply({ enabled, allowedOrigins: [...allowedOrigins, value], port })
                  }
                >
                  {value}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {error || loadFailed ? (
          <p className="text-xs text-destructive" data-testid="browser-access-error">
            {error ?? t("loadFailed")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
