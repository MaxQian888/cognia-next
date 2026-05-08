"use client"

/**
 * Share-target receiver (Wave 3.4).
 *
 * Two paths reach this route:
 *   1. Android `<intent-filter ACTION_SEND>` (`mobile/android/.../AndroidManifest.xml`)
 *      → Capacitor's `App` plugin emits an `appUrlOpen` with a
 *      `cognia://share?text=...&url=...` deeplink that the boot provider
 *      already routes here.
 *   2. iOS Share Extension (HITL — see `mobile/IOS_BOOTSTRAP.md`) — same
 *      deeplink shape after the extension hands off.
 *   3. Web Share Target (`navigator.share` reverse) — query params on
 *      direct navigation `/share-target?text=...`.
 *
 * Implementation is route-only — picks a session from the existing chat
 * sessions list and enqueues a `connector_send` outbound job carrying the
 * received text / url. No special inbox state.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { listSessions } from "@/lib/db/sessions"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { ChatSession } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export default function ShareTargetPage() {
  const t = useTranslations("mobile.shareTarget")
  const router = useRouter()
  const params = useSearchParams()
  const text = params?.get("text") ?? ""
  const url = params?.get("url") ?? ""

  const [search, setSearch] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)

  const sessions = useLiveQuery<ChatSession[]>(() => listSessions(), []) ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q))
  }, [search, sessions])

  // Compose the canonical body: prefer text, fall back to url, otherwise
  // both. Mirrors the Web Share Target conventions.
  const body = useMemo(() => {
    if (text && url) return `${text}\n${url}`
    return text || url
  }, [text, url])

  // If neither text nor url showed up, kick the user back to the inbox.
  useEffect(() => {
    if (!text && !url) {
      const id = window.setTimeout(() => router.replace("/"), 800)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [text, url, router])

  const onSendTo = async (session: ChatSession) => {
    if (busyId) return
    setBusyId(session.id)
    try {
      await enqueue({
        command: "connector_send",
        payload: { sessionId: session.id, segments: [{ type: "text", text: body }] },
        label: `Share → ${session.title ?? session.id}`,
      })
      toast.success(t("queuedToast"))
      router.replace("/")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col bg-background safe-area-pt"
      data-testid="share-target-page"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label={t("cancel")}
          className="touch-target -ml-2 flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60"
          data-testid="share-target-back"
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <h1 className="text-lg font-semibold">{t("title")}</h1>
      </header>

      <section className="px-4 pt-3">
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        {body ? (
          <Card className="mt-3" data-testid="share-target-preview">
            <CardContent className="p-3 text-sm">
              {text ? (
                <p>
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {t("receivedText")}
                  </span>
                  <br />
                  <span className="break-words">{text}</span>
                </p>
              ) : null}
              {url ? (
                <p className="mt-2 break-all text-xs">
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {t("receivedUrl")}
                  </span>
                  <br />
                  <a href={url} className="text-primary underline" rel="noopener noreferrer">
                    {url}
                  </a>
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </section>

      <section className="mt-3 flex flex-col gap-2 px-4 pb-6">
        <Input
          type="search"
          placeholder={t("targetSearchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-testid="share-target-search"
        />
        {filtered.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">{t("noConversations")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((s) => (
              <li key={s.id}>
                <Button
                  type="button"
                  onClick={() => void onSendTo(s)}
                  disabled={busyId === s.id || !body}
                  className={cn("w-full justify-between")}
                  variant="outline"
                  data-testid={`share-target-pick-${s.id}`}
                >
                  <span className="truncate">{s.title ?? s.id}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <SendIcon className="size-3.5" />
                    {t("sendCta")}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
