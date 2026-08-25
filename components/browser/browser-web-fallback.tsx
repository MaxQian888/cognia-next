"use client"

import { ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { type FormEvent, useRef, useState } from "react"

import { BrowserEmptyState } from "@/components/browser/browser-empty-state"
import { BrowserNavigationControls } from "@/components/browser/browser-navigation-controls"
import { BrowserToolbar, addressDisplayParts } from "@/components/browser/browser-toolbar"
import { WebPreview } from "@/components/ai-elements/web-preview"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useElementWidth } from "@/hooks/use-element-width"
import { normalizePreviewUrl } from "@/lib/browser/protocol"
import { openExternal } from "@/lib/tauri/opener"

export interface BrowserWebFallbackProps {
  initialUrl?: string
  /**
   * Why the cloud browser is not being used. Absent means "not switched on",
   * which is the existing invitation to switch it on; present means it IS on
   * and something else is missing, so inviting again would be nonsense.
   */
  unreachableReason?: string
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
export function BrowserWebFallback({ initialUrl, unreachableReason }: BrowserWebFallbackProps) {
  const t = useTranslations("browser")
  const toolbarRef = useRef<HTMLDivElement>(null)
  const frameViewportRef = useRef<HTMLDivElement>(null)
  const frameViewportWidth = useElementWidth(frameViewportRef)
  const pageScale =
    frameViewportWidth > 0 ? Math.min(1, frameViewportWidth / MIN_DESKTOP_PAGE_WIDTH) : 1
  const normalizedInitialUrl = initialUrl ? normalizeWebUrl(initialUrl) : null
  // The same back/forward model the embedded pane uses — this component is
  // where the shape was first proven, so it now consumes the shared hook
  // instead of keeping a second copy of it.
  const { push, goBack, goForward, canGoBack, canGoForward } = useBrowserHistory()
  const [currentUrl, setCurrentUrl] = useState(normalizedInitialUrl ?? "")
  const [draftUrl, setDraftUrl] = useState(normalizedInitialUrl ?? "")
  const [reloadKey, setReloadKey] = useState(0)

  // Seed the stack with the initial address exactly once.
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    if (normalizedInitialUrl) push(normalizedInitialUrl)
  }

  /** Open a brand-new address (quick-open chip): a push, not a traversal. */
  const goToNew = (url: string) => {
    push(url)
    setCurrentUrl(url)
    setDraftUrl(url)
  }

  const goTo = (url: string | null) => {
    if (!url) return
    setCurrentUrl(url)
    setDraftUrl(url)
  }

  const commitDraft = () => {
    const normalized = normalizeWebUrl(draftUrl)
    if (!normalized) return
    push(normalized)
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
        <BrowserToolbar
          toolbarRef={toolbarRef}
          url={draftUrl}
          onUrlChange={setDraftUrl}
          onSubmit={navigate}
          addressDisplay={draftUrl === currentUrl ? addressDisplayParts(draftUrl) : null}
          navigation={
            <BrowserNavigationControls
              backDisabled={!canGoBack}
              forwardDisabled={!canGoForward}
              reloadDisabled={!currentUrl}
              onBack={() => goTo(goBack())}
              onForward={() => goTo(goForward())}
              onReload={() => setReloadKey((key) => key + 1)}
            />
          }
          pageActions={
            <TooltipIconButton
              tooltip={t("actions.openExternal")}
              aria-label={t("actions.openExternal")}
              disabled={!currentUrl}
              onClick={() => void openExternal(currentUrl)}
            >
              <ExternalLinkIcon />
            </TooltipIconButton>
          }
        />
        <div className="flex min-w-0 items-center gap-3 border-b bg-muted/40 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {unreachableReason ?? t("webFallback.notice")}
          </p>
          {!unreachableReason && (
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href="/settings?section=companion">{t("webFallback.enableRemote")}</Link>
            </Button>
          )}
        </div>
        <div
          ref={frameViewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="browser-web-frame-viewport"
        >
          {!currentUrl && <BrowserEmptyState onOpen={goToNew} />}
          <iframe
            key={`${currentUrl}:${reloadKey}`}
            className="absolute left-0 top-0 max-w-none bg-background"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            src={currentUrl || undefined}
            hidden={!currentUrl}
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
