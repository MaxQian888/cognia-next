"use client"

import { ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { type FormEvent, useRef, useState } from "react"

import { BrowserNavigationControls } from "@/components/browser/browser-navigation-controls"
import { WebPreview, WebPreviewNavigation } from "@/components/ai-elements/web-preview"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useElementWidth } from "@/hooks/use-element-width"
import { normalizePreviewUrl } from "@/lib/browser/protocol"
import { openExternal } from "@/lib/tauri/opener"

export interface BrowserWebFallbackProps {
  initialUrl?: string
}

// Cross-origin iframe CSS cannot be rewritten. Give desktop-only pages their
// common minimum layout width, then fit that surface to the actual host pane.
const MIN_DESKTOP_PAGE_WIDTH = 1024

function normalizeWebUrl(input: string): string | null {
  const normalized = normalizePreviewUrl(input)
  if (!normalized) return null
  return /^https?:\/\//i.test(input.trim()) ? input.trim() : normalized
}

/**
 * Best-effort Web browser surface. It deliberately keeps its own submitted
 * history because cross-origin iframe navigation is opaque to the host page.
 */
export function BrowserWebFallback({ initialUrl }: BrowserWebFallbackProps) {
  const t = useTranslations("browser")
  const frameViewportRef = useRef<HTMLDivElement>(null)
  const frameViewportWidth = useElementWidth(frameViewportRef)
  const pageScale =
    frameViewportWidth > 0 ? Math.min(1, frameViewportWidth / MIN_DESKTOP_PAGE_WIDTH) : 1
  const normalizedInitialUrl = initialUrl ? normalizeWebUrl(initialUrl) : null
  const [history, setHistory] = useState<string[]>(
    normalizedInitialUrl ? [normalizedInitialUrl] : []
  )
  const [historyIndex, setHistoryIndex] = useState(normalizedInitialUrl ? 0 : -1)
  const [currentUrl, setCurrentUrl] = useState(normalizedInitialUrl ?? "")
  const [draftUrl, setDraftUrl] = useState(normalizedInitialUrl ?? "")
  const [reloadKey, setReloadKey] = useState(0)

  const goToHistoryIndex = (nextIndex: number) => {
    const url = history[nextIndex]
    if (!url) return
    setHistoryIndex(nextIndex)
    setCurrentUrl(url)
    setDraftUrl(url)
  }

  const commitDraft = () => {
    const normalized = normalizeWebUrl(draftUrl)
    if (!normalized) return
    const nextHistory = [...history.slice(0, historyIndex + 1), normalized]
    setHistory(nextHistory)
    setHistoryIndex(nextHistory.length - 1)
    setCurrentUrl(normalized)
    setDraftUrl(normalized)
  }

  const navigate = (event: FormEvent) => {
    event.preventDefault()
    commitDraft()
  }

  return (
    <TooltipProvider>
      <WebPreview
        className="h-full min-h-0 min-w-0 max-w-full overflow-hidden rounded-none border-0"
        data-testid="browser-web-preview"
        defaultUrl={normalizedInitialUrl ?? ""}
      >
        <WebPreviewNavigation>
          <BrowserNavigationControls
            backDisabled={historyIndex <= 0}
            forwardDisabled={historyIndex < 0 || historyIndex >= history.length - 1}
            reloadDisabled={!currentUrl}
            onBack={() => goToHistoryIndex(historyIndex - 1)}
            onForward={() => goToHistoryIndex(historyIndex + 1)}
            onReload={() => setReloadKey((key) => key + 1)}
          />
          <form className="min-w-0 flex-1" onSubmit={navigate}>
            <Input
              className="h-8"
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  commitDraft()
                }
              }}
              inputMode="url"
              placeholder={t("url.placeholder")}
              aria-label={t("url.placeholder")}
            />
          </form>
          <TooltipIconButton
            tooltip={t("actions.openExternal")}
            aria-label={t("actions.openExternal")}
            disabled={!currentUrl}
            onClick={() => void openExternal(currentUrl)}
          >
            <ExternalLinkIcon />
          </TooltipIconButton>
        </WebPreviewNavigation>
        <div className="flex min-w-0 items-center gap-3 border-b bg-muted/40 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("webFallback.notice")}</p>
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link href="/settings?section=companion">{t("webFallback.enableRemote")}</Link>
          </Button>
        </div>
        <div
          ref={frameViewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="browser-web-frame-viewport"
        >
          <iframe
            key={`${currentUrl}:${reloadKey}`}
            className="absolute left-0 top-0 max-w-none bg-background"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            src={currentUrl || undefined}
            style={{
              width: `${100 / pageScale}%`,
              height: `${100 / pageScale}%`,
              transform: `scale(${pageScale})`,
              transformOrigin: "top left",
            }}
            title={t("webFallback.frameTitle")}
          />
        </div>
      </WebPreview>
    </TooltipProvider>
  )
}
