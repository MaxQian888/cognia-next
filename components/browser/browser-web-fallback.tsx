"use client"

import { ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { type FormEvent, useRef, useState } from "react"
import { toast } from "sonner"

import { BrowserEmptyState } from "@/components/browser/browser-empty-state"
import { BrowserHistoryMenu } from "@/components/browser/browser-history-menu"
import { BrowserNavigationControls } from "@/components/browser/browser-navigation-controls"
import { BrowserToolbar, addressDisplayParts } from "@/components/browser/browser-toolbar"
import { WebPreview } from "@/components/ai-elements/web-preview"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useRecentPages } from "@/hooks/browser/use-recent-pages"
import { useElementWidth } from "@/hooks/use-element-width"
import { normalizePreviewUrl } from "@/lib/browser/protocol"
import { openExternal } from "@/lib/tauri/opener"

export interface BrowserWebFallbackProps {
  initialUrl?: string
  /**
   * An address the host is asking this surface to go to now, e.g. a link the
   * user clicked in the conversation. See `BrowserPreviewPane`'s prop of the
   * same name. Every change is a fresh navigation, so it goes onto the
   * back/forward stack exactly like typing one in.
   */
  requestedUrl?: string
  /**
   * Which request `requestedUrl` belongs to. The same address stated twice is
   * two requests; without this the second one deduplicated away.
   */
  requestNonce?: number
  /**
   * Why the cloud browser is not being used. Absent means "not switched on",
   * which is the existing invitation to switch it on; present means it IS on
   * and something else is missing, so inviting again would be nonsense.
   */
  unreachableReason?: string
}

/**
 * Where the cloud-browser switch lives. `?section=companion` is a retired
 * section that now lands on the Connectivity overview, a panel away from the
 * card the button promises.
 */
const REMOTE_BROWSER_SETTINGS_HREF = "/settings?section=connectivity&connectivityPanel=cloud-relay"

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
export function BrowserWebFallback({
  initialUrl,
  requestedUrl,
  requestNonce,
  unreachableReason,
}: BrowserWebFallbackProps) {
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
  const { recent, clear: clearRecent } = useRecentPages()
  const clearHistory = () => {
    void clearRecent().then((cleared) => {
      if (!cleared) toast.error(t("history.clearFailed"))
    })
  }
  const [currentUrl, setCurrentUrl] = useState(normalizedInitialUrl ?? "")
  const [draftUrl, setDraftUrl] = useState(normalizedInitialUrl ?? "")
  const [reloadKey, setReloadKey] = useState(0)
  /**
   * An iframe document is in flight. The frame is re-keyed on every address and
   * reload, so its `load` (which also fires for a page that refused framing) is
   * the one signal that the navigation settled. This surface used to show no
   * progress at all while the other two drew the toolbar's bar.
   */
  const [loading, setLoading] = useState(!!normalizedInitialUrl)

  /** Open a brand-new address (quick-open chip): a push, not a traversal. */
  const goToNew = (url: string) => {
    push(url)
    setCurrentUrl(url)
    setDraftUrl(url)
    setLoading(true)
  }

  // Seed the stack with the initial address, then follow every address the host
  // states afterwards. This used to be a one-shot `seeded` flag, which is why a
  // link clicked in the conversation reached the pane and then went nowhere:
  // the parent held it in state this surface does not read.
  //
  // Keyed on the request token, not the address alone: the user browses on
  // inside this surface, so re-stating the page they came from is a real
  // request. Comparing addresses made that second click a no-op.
  const normalizedRequestedUrl = requestedUrl ? normalizeWebUrl(requestedUrl) : null
  const [applied, setApplied] = useState<{ key: string; url: string } | null>(null)
  // The seed only applies while nothing has been applied yet. Falling back to
  // it whenever `requestedUrl` goes absent would drag the user back to the
  // pane's first page the moment a host cleared its request.
  const nextAddress = normalizedRequestedUrl ?? (applied === null ? normalizedInitialUrl : null)
  const nextKey = normalizedRequestedUrl
    ? `${requestNonce ?? 0}:${normalizedRequestedUrl}`
    : `seed:${nextAddress ?? ""}`
  if (nextAddress && nextKey !== applied?.key) {
    setApplied({ key: nextKey, url: nextAddress })
    goToNew(nextAddress)
  }

  const goTo = (url: string | null) => {
    if (!url) return
    setCurrentUrl(url)
    setDraftUrl(url)
    setLoading(true)
  }

  const commitDraft = () => {
    const normalized = normalizeWebUrl(draftUrl)
    if (!normalized) return
    goToNew(normalized)
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
          loading={loading}
          navigation={
            <BrowserNavigationControls
              backDisabled={!canGoBack}
              forwardDisabled={!canGoForward}
              reloadDisabled={!currentUrl}
              onBack={() => goTo(goBack())}
              onForward={() => goTo(goForward())}
              onReload={() => {
                setReloadKey((key) => key + 1)
                setLoading(true)
              }}
            />
          }
          inspectActions={
            <BrowserHistoryMenu
              recent={recent}
              onNavigate={goToNew}
              onClear={clearHistory}
              disabled={recent.length === 0}
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
              <Link href={REMOTE_BROWSER_SETTINGS_HREF}>{t("webFallback.enableRemote")}</Link>
            </Button>
          )}
        </div>
        <div
          ref={frameViewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="browser-web-frame-viewport"
        >
          {!currentUrl && <BrowserEmptyState onOpen={goToNew} recent={recent} />}
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
            onLoad={() => setLoading(false)}
            onError={() => setLoading(false)}
          />
        </div>
      </WebPreview>
    </TooltipProvider>
  )
}
