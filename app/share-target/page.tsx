"use client"

/**
 * Share-target receiver (Wave 3.4).
 *
 * Two paths reach this route:
 *   1. Android `<intent-filter ACTION_SEND>` (`mobile/android/.../AndroidManifest.xml`)
 *      → `MainActivity.rewriteShareIntent` converts the SEND intent into a
 *      `cognia://share?text=...&url=...` VIEW deeplink (Capacitor's `App`
 *      plugin only surfaces data-URI intents), which the boot provider
 *      already routes here via `appUrlOpen` / `getLaunchUrl`.
 *   2. iOS Share Extension (HITL — see `mobile/IOS_BOOTSTRAP.md`) — same
 *      deeplink shape after the extension hands off.
 *   3. Web Share Target (`navigator.share` reverse) — query params on
 *      direct navigation `/share-target?text=...`.
 *
 * Implementation is route-only — picks a session from the existing chat
 * sessions list and enqueues a `connector_send` outbound job carrying the
 * received text / url. No special inbox state.
 */

import { Suspense, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, FilePlusIcon, InboxIcon, PlusCircleIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Item, ItemGroup, ItemContent, ItemTitle, ItemActions } from "@/components/ui/item"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { setDraft } from "@/lib/db/chat-drafts"
import { createSession, listSessions } from "@/lib/db/sessions"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { ChatSession } from "@cognia/agent-config-types"

export default function ShareTargetPage() {
  return (
    <Suspense fallback={null}>
      <ShareTargetPageInner />
    </Suspense>
  )
}

/**
 * Derive a sensible 50-char-max session title from the shared payload.
 *
 * Prefers the sharer's own `title` when there is one: an article share carries
 * the headline there, and guessing from the body text when the sharer already
 * said what this is would be worse for no reason. Then the first non-empty
 * line of `text`, then the hostname of `url`, so the picker always shows
 * something recognisable.
 *
 * Takes the next-intl `t` (scoped to `mobile.shareTarget`) so the
 * derived title respects the user's locale. The `fromUrl` and
 * `fallback` keys are added in both `i18n/messages/en.json` and
 * `i18n/messages/zh-CN.json` under `mobile.shareTarget.derivedTitle`.
 */
function deriveTitle(
  title: string,
  text: string,
  url: string,
  t: (key: string, params?: Record<string, string | number | Date>) => string
): string {
  const clamp = (value: string) => (value.length > 50 ? `${value.slice(0, 49)}…` : value)
  const named = title.trim()
  if (named) return clamp(named)
  const trimmed = text.trim()
  if (trimmed) {
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ""
    return clamp(firstLine)
  }
  if (url) {
    try {
      const u = new URL(url)
      return t("derivedTitle.fromUrl", { hostname: u.hostname })
    } catch {
      return url.slice(0, 50)
    }
  }
  return t("derivedTitle.fallback")
}

function ShareTargetPageInner() {
  const t = useTranslations("mobile.shareTarget")
  const router = useRouter()
  const params = useSearchParams()
  const text = params?.get("text") ?? ""
  const url = params?.get("url") ?? ""
  // Declared in the web manifest's `share_target.params` alongside the other
  // two. Android's share sheet sends it for most link shares, and dropping it
  // threw away the one line that says what the user actually shared.
  const title = params?.get("title") ?? ""

  const [search, setSearch] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)
  const keyboard = useKeyboardInsets()

  const sessionsRaw = useLiveQuery<ChatSession[]>(() => listSessions(), [])
  const sessions = useMemo(() => sessionsRaw ?? [], [sessionsRaw])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q))
  }, [search, sessions])

  // Compose the canonical body. Mirrors the Web Share Target conventions:
  // any of the three may be absent, and a sharer that sends a title plus a URL
  // (the common shape for an article) must not lose the title.
  const body = useMemo(() => {
    // Skip a title the text already opens with, which is what a "share
    // selection" flow produces: repeating it reads as a stutter.
    const parts = [title && !text.trim().startsWith(title.trim()) ? title : "", text, url].filter(
      (part) => part.trim().length > 0
    )
    return parts.join("\n")
  }, [text, title, url])

  // If nothing at all showed up, kick the user back to the inbox.
  useEffect(() => {
    if (!body) {
      const id = window.setTimeout(() => router.replace("/"), 800)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [body, router])

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

  // "New session" target — provision a fresh session row and queue the
  // outbound send with the shared body. Falls back to /inbox if creation
  // throws so the user never lands on the share screen indefinitely.
  const onSendToNew = async () => {
    if (busyId) return
    setBusyId("__new__")
    try {
      const session = await createSession({ title: deriveTitle(title, text, url, t) })
      await enqueue({
        command: "connector_send",
        payload: { sessionId: session.id, segments: [{ type: "text", text: body }] },
        label: `Share → ${session.title ?? session.id}`,
      })
      toast.success(t("queuedToast"))
      router.replace(`/?session=${encodeURIComponent(session.id)}`)
    } catch (err) {
      toast.error(t("createSessionFailed"))
      console.warn("share-target: createSession failed", err)
    } finally {
      setBusyId(null)
    }
  }

  // "Inbox draft" target — stash the body as a chat draft on a fresh
  // session without firing the outbound send. The user can finish/edit
  // it inside the regular composer when they're ready.
  const onSaveDraft = async () => {
    if (busyId) return
    setBusyId("__draft__")
    try {
      const session = await createSession({ title: deriveTitle(title, text, url, t) })
      await setDraft(session.id, body)
      toast.success(t("draftSavedToast"))
      router.replace(`/?session=${encodeURIComponent(session.id)}`)
    } catch (err) {
      toast.error(t("createSessionFailed"))
      console.warn("share-target: setDraft failed", err)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col bg-background safe-area-pt"
      style={{ paddingBottom: keyboard.keyboardHeight ? keyboard.keyboardHeight + 16 : undefined }}
      data-testid="share-target-page"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => router.back()}
          aria-label={t("cancel")}
          className="-ml-2 rounded-full"
          data-testid="share-target-back"
        >
          <ArrowLeftIcon className="size-5" />
        </Button>
        <h1 className="text-lg font-semibold">{t("title")}</h1>
      </header>

      <section className="px-4 pt-3">
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        {body ? (
          <Card className="mt-3" data-testid="share-target-preview">
            <CardContent className="p-3 text-sm">
              {/* Shown first because it is what the sharer named the thing. A
                  preview that lists the body and the link but not the headline
                  is missing the one line the user recognises. */}
              {title ? (
                <p className="mb-2">
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {t("receivedTitle")}
                  </span>
                  <br />
                  <span className="break-words font-medium">{title}</span>
                </p>
              ) : null}
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
        <div className="grid grid-cols-2 gap-2" data-testid="share-target-quick-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="touch-target justify-start gap-2"
            onClick={() => void onSendToNew()}
            disabled={!body || busyId !== null}
            data-testid="share-target-new-session"
          >
            <PlusCircleIcon className="size-4" aria-hidden="true" />
            {t("newSessionCta")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="touch-target justify-start gap-2"
            onClick={() => void onSaveDraft()}
            disabled={!body || busyId !== null}
            data-testid="share-target-inbox-draft"
          >
            <InboxIcon className="size-4" aria-hidden="true" />
            {t("inboxDraftCta")}
          </Button>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <FilePlusIcon className="size-3 text-muted-foreground" aria-hidden="true" />
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("orExistingSession")}
          </span>
        </div>
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
          <Empty data-testid="share-target-empty">
            <EmptyHeader>
              <EmptyTitle>{t("noConversations")}</EmptyTitle>
              <EmptyDescription>{t("noConversationsDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {filtered.map((s) => (
              <Item key={s.id} variant="outline" size="sm" asChild>
                <button
                  type="button"
                  onClick={() => void onSendTo(s)}
                  disabled={busyId === s.id || !body}
                  data-testid={`share-target-pick-${s.id}`}
                  className="w-full text-left disabled:opacity-50"
                >
                  <ItemContent>
                    <ItemTitle className="truncate">{s.title ?? s.id}</ItemTitle>
                  </ItemContent>
                  <ItemActions className="text-xs text-muted-foreground">
                    <SendIcon className="size-3.5" />
                    {t("sendCta")}
                  </ItemActions>
                </button>
              </Item>
            ))}
          </ItemGroup>
        )}
      </section>
    </main>
  )
}
