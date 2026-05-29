"use client"

/**
 * Public share viewer (ADR-0037 Phase 4).
 *
 * The single viewer for every share kind, replacing the standalone Vite SPA.
 * It ships in the app's static export (`out/`), so it renders both on the
 * public Cloudflare Pages deployment AND inside the Tauri desktop shell (the
 * owner can open their own shares here). The decryption key arrives in the URL
 * `#fragment` and never leaves the browser — `loadShare` reads it client-side
 * after hydration and decrypts via the app's own share crypto. For a local,
 * no-network preview-before-publish, callers render `<PayloadView>` directly
 * (see `share-link-dialog`); this route always does the fetch+decrypt flow.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { resolveShareEndpoint } from "@/lib/share/config"
import {
  loadShare,
  decryptEnvelope,
  type ShareLoadState,
  type ShareLoadErrorReason,
} from "@/lib/share/load"
import { PayloadView } from "@/components/share/payload-view"

const ERROR_KEY: Record<ShareLoadErrorReason, string> = {
  "not-a-link": "error.notLink",
  network: "error.network",
  "invalid-key": "error.invalidKey",
  integrity: "error.integrity",
}

export default function ShareViewPage() {
  return <ShareView />
}

export function ShareView() {
  const t = useTranslations("share.view")
  const [state, setState] = useState<ShareLoadState>({ status: "loading" })

  useEffect(() => {
    let active = true
    void (async () => {
      const { baseUrl } = await resolveShareEndpoint()
      const next = await loadShare(baseUrl, window.location.search, window.location.hash)
      if (active) setState(next)
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (state.status === "ready" && state.payload.title) {
      document.title = `${state.payload.title} · cognia`
    }
  }, [state])

  return (
    <main className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <div
        className={cn(
          "flex flex-1 justify-center p-4 sm:p-8",
          state.status === "ready" ? "items-start" : "items-center"
        )}
      >
        <Body state={state} onState={setState} />
      </div>
      <footer className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">
        {t("footer")}
      </footer>
    </main>
  )
}

function Body({ state, onState }: { state: ShareLoadState; onState: (s: ShareLoadState) => void }) {
  const t = useTranslations("share.view")

  switch (state.status) {
    case "loading":
      return <p className="text-sm text-muted-foreground">{t("loading")}</p>
    case "unavailable":
      return (
        <Centered>
          <h1 className="text-xl font-semibold">{t("unavailableTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("unavailableBody")}</p>
        </Centered>
      )
    case "error":
      return (
        <Centered>
          <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t(ERROR_KEY[state.reason])}</p>
        </Centered>
      )
    case "passphrase":
      return (
        <PassphraseGate
          wrong={state.wrong}
          onSubmit={async (pass) => {
            onState({ status: "loading" })
            onState(await decryptEnvelope(state.envelope, state.key, pass))
          }}
        />
      )
    case "ready":
      return <PayloadView payload={state.payload} className="w-full" />
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex max-w-md flex-col items-center gap-2 text-center">{children}</div>
}

function PassphraseGate({
  wrong,
  onSubmit,
}: {
  wrong?: boolean
  onSubmit: (passphrase: string) => void
}) {
  const t = useTranslations("share.view")
  const [value, setValue] = useState("")
  return (
    <div className="flex max-w-md flex-col items-center gap-3 text-center">
      <h1 className="text-xl font-semibold">{t("passphraseTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("passphraseBody")}</p>
      <form
        className="flex w-full flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (value) onSubmit(value)
        }}
      >
        <input
          type="password"
          aria-label={t("passphraseLabel")}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("passphrasePlaceholder")}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("passphraseSubmit")}
        </button>
      </form>
      {wrong ? <p className="text-sm text-destructive">{t("passphraseWrong")}</p> : null}
    </div>
  )
}
