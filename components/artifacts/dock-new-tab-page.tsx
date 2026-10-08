"use client"

/**
 * The chat dock's start page (ADR-0214, D7): what an empty dock — or a `+` on
 * its tab strip — opens on, in place of the old "No artifacts yet" landing.
 *
 * A browser's new-tab page in shape, a task launcher in content:
 *
 * - an omnibox — an address opens a page, a path serves the local file, any
 *   other text is handed to the ⌘K palette with the words already typed (the
 *   palette already searches files, artifacts and panels in this workspace's
 *   scope; a second results list here would be a second search UI);
 * - this task's tools, each opening its panel in place of this tab, plus the
 *   terminal, which is the bottom panel rather than a dock tab (R7);
 * - this task's artifacts;
 * - suggestions: the project's launch configurations (`.claude/launch.json`),
 *   running dev servers and local files (desktop), links this
 *   conversation shared, and — once the managed Chromium is installed — the
 *   Chrome Web Store for its extensions;
 * - recent pages, which are global (R12) and labelled so.
 *
 * It never starts Chromium: an address it opens becomes a page tab in this
 * tab's place (`onOpenPage`), and the browser panel picks the engine when the
 * tab is shown. There is no "Browser" tile for the same reason — a page is
 * opened by its address, and the task's open pages are tabs already.
 */

import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowRightIcon,
  FileDiffIcon,
  GlobeIcon,
  HistoryIcon,
  LayoutGridIcon,
  LinkIcon,
  PuzzleIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react"

import { getArtifactTypeIcon } from "@/components/artifacts/artifact-icons"
import { historyLabel } from "@/components/browser/browser-history-menu"
import { LocalChromiumInstall } from "@/components/browser/browser-backend-switcher"
import { BrowserLaunchConfigs } from "@/components/browser/launch/browser-launch-configs"
import { BrowserExtensionsPanel } from "@/components/browser/extensions/browser-extensions-panel"
import { BrowserLocalContentPicker } from "@/components/browser/local-content/browser-local-content-picker"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import { useRecentPages } from "@/hooks/browser/use-recent-pages"
import { useSessionResourceChanges } from "@/hooks/chat/use-session-resource-changes"
import { localPathFromAddress, serveLocalFile } from "@/lib/browser/local-content-client"
import { isLocalHostname, normalizePreviewUrl } from "@/lib/browser/protocol"
import { collectAssistantOutputFiles, collectSharedLinks } from "@/lib/chat/session-links"
import {
  getActiveContextRevision,
  getActiveContextResource,
  getActiveWorkbenchPanels,
  subscribeActiveContext,
} from "@/lib/context-workbench/active-context"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveWorkbenchPanelLabel } from "@/lib/context-workbench/panel-label"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { isTauri } from "@/lib/tauri"
import { terminalAvailable } from "@/lib/terminal/pick-transport"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { Artifact } from "@/types"

import { DOCK_SESSION_PANEL_META, NEW_TAB_PANEL_ID } from "./dock-panel-meta"

/** The tools drawn as tiles, in this order, when the task has them. */
export const NEW_TAB_TOOL_PANEL_IDS = ["workspace", "session-sidechat", "metadata"]

/** Panels the page never offers as tools: pages are opened by address. */
const NOT_A_TOOL = new Set([NEW_TAB_PANEL_ID, "browser"])

/** Where the managed Chromium's extensions come from. */
export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/"

const ARTIFACT_LIMIT = 6
const LINK_LIMIT = 5
const RECENT_LIMIT = 6

export type OmniboxTarget =
  { kind: "url"; url: string } | { kind: "path"; path: string } | { kind: "search"; query: string }

/**
 * What the omnibox should do with `input`, or `null` for nothing to do.
 *
 * An address needs to look like one — a scheme, a dotted host, `localhost`, an
 * IP or a port — because `normalizePreviewUrl` accepts any single word as a
 * host: "react" would otherwise open `https://react/` instead of searching.
 */
export function resolveOmniboxTarget(input: string): OmniboxTarget | null {
  const text = input.trim()
  if (!text) return null
  const path = localPathFromAddress(text)
  if (path) return { kind: "path", path }
  if (!/\s/.test(text)) {
    const hasScheme = /^https?:\/\//i.test(text)
    const url = normalizePreviewUrl(text)
    if (url) {
      const { hostname, port } = new URL(url)
      if (hasScheme || hostname.includes(".") || port || isLocalHostname(hostname)) {
        return { kind: "url", url }
      }
    }
  }
  return { kind: "search", query: text }
}

export interface DockNewTabPageProps {
  sessionId: string | null
  messages: readonly UIMessage[]
  /** Open a session panel in place of this tab. */
  onOpenPanel: (panelId: string) => void
  /** Open an address as a page tab in place of this tab. */
  onOpenPage: (url: string) => void
  /** The desktop host: dev servers, local files and the managed Chromium. */
  desktop?: boolean
}

interface ToolEntry {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

/** The session surface's panels as the workbench published them. */
function useAvailablePanels(): ToolEntry[] {
  const t = useTranslations()
  const revision = useSyncExternalStore(
    subscribeActiveContext,
    getActiveContextRevision,
    getActiveContextRevision
  )
  return useMemo(() => {
    void revision
    // The page renders inside the session surface, which is the host the
    // workbench published last; anything else (a stale artifact host) has no
    // session tools to offer.
    if (getActiveContextResource()?.kind !== "session") return []
    return getActiveWorkbenchPanels()
      .filter((panel) => !NOT_A_TOOL.has(panel.id))
      .map((panel) => ({
        id: panel.id,
        label: resolveWorkbenchPanelLabel(t, panel, panel.labelKey),
        icon:
          DOCK_SESSION_PANEL_META[panel.id]?.icon ??
          contextPanelRegistry.get(panel.id)?.icon ??
          PuzzleIcon,
      }))
  }, [revision, t])
}

function toTime(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") return Date.parse(value) || 0
  return 0
}

export function DockNewTabPage({
  sessionId,
  messages,
  onOpenPanel,
  onOpenPage,
  desktop = isTauri(),
}: DockNewTabPageProps) {
  const t = useTranslations("contextWorkbench.newTab")
  const tSummary = useTranslations("contextWorkbench.summaryCard")
  const [query, setQuery] = useState("")
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const setActiveArtifact = useArtifactStore((state) => state.setActiveArtifact)
  const allArtifacts = useArtifactStore((state) => state.artifacts)
  const terminalOpen = useTerminalStore((state) => state.panelOpen)
  const toggleTerminal = useTerminalStore((state) => state.togglePanel)
  const local = useLocalBrowser({ enabled: desktop })
  const { recent } = useRecentPages(RECENT_LIMIT)
  const changes = useSessionResourceChanges(sessionId)
  const panels = useAvailablePanels()

  const artifacts = useMemo<Artifact[]>(
    () =>
      sessionId
        ? Object.values(allArtifacts)
            .filter((artifact) => artifact.sessionId === sessionId)
            .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))
            .slice(0, ARTIFACT_LIMIT)
        : [],
    [allArtifacts, sessionId]
  )
  const links = useMemo(
    () => collectSharedLinks(messages, collectAssistantOutputFiles(messages)).slice(0, LINK_LIMIT),
    [messages]
  )

  const tools = NEW_TAB_TOOL_PANEL_IDS.map((id) => panels.find((panel) => panel.id === id)).filter(
    (panel): panel is ToolEntry => Boolean(panel)
  )
  const moreTools = panels.filter((panel) => !NEW_TAB_TOOL_PANEL_IDS.includes(panel.id))
  const chromiumInstalled = Boolean(local.status?.installed)
  const showInstall = desktop && local.supported && local.status !== null && !chromiumInstalled

  const openPath = async (path: string) => {
    try {
      const served = await serveLocalFile(path)
      onOpenPage(served.url)
    } catch {
      toast.error(t("openFailed", { path }))
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const target = resolveOmniboxTarget(query)
    if (!target) return
    if (target.kind === "url") onOpenPage(target.url)
    else if (target.kind === "path") {
      if (desktop) void openPath(target.path)
      else toast.error(t("openFailed", { path: target.path }))
    } else requestCommandPalette({ query: target.query })
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="dock-new-tab-page">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8">
        <form onSubmit={submit} className="relative" role="search">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("omniboxLabel")}
            placeholder={t("omniboxPlaceholder")}
            className="h-10 rounded-pill pr-10 pl-9"
            autoFocus
            data-testid="dock-new-tab-omnibox"
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="ghost"
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
            aria-label={t("go")}
            disabled={!query.trim()}
          >
            <ArrowRightIcon className="size-4" />
          </Button>
        </form>

        {showInstall ? (
          <section
            className="rounded-lg border bg-muted/30 p-3"
            aria-label={t("installTitle")}
            data-testid="dock-new-tab-install"
          >
            <p className="mb-2 text-xs font-medium">{t("installTitle")}</p>
            <LocalChromiumInstall local={local} />
          </section>
        ) : null}

        <Section title={t("tools")}>
          <div className="grid grid-cols-2 gap-2 @[28rem]:grid-cols-3">
            {tools.map((tool) =>
              tool.id === "workspace" ? (
                <Tile
                  key={tool.id}
                  icon={FileDiffIcon}
                  label={t("changes")}
                  detail={
                    changes.totals.files > 0
                      ? changes.totals.linesKnown
                        ? `+${changes.totals.insertions} −${changes.totals.deletions}`
                        : tSummary("changesFiles", { count: changes.totals.files })
                      : undefined
                  }
                  onClick={() => onOpenPanel(tool.id)}
                  testId={`dock-new-tab-tool-${tool.id}`}
                />
              ) : (
                <Tile
                  key={tool.id}
                  icon={tool.icon}
                  label={tool.label}
                  onClick={() => onOpenPanel(tool.id)}
                  testId={`dock-new-tab-tool-${tool.id}`}
                />
              )
            )}
            {chromiumInstalled ? (
              <Tile
                icon={PuzzleIcon}
                label={t("extensions")}
                onClick={() => setExtensionsOpen(true)}
                testId="dock-new-tab-tool-extensions"
              />
            ) : null}
            {terminalAvailable() ? (
              <Tile
                icon={SquareTerminalIcon}
                label={t("terminal")}
                pressed={terminalOpen}
                onClick={toggleTerminal}
                testId="dock-new-tab-tool-terminal"
              />
            ) : null}
            {moreTools.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={TILE_CLASS}
                    data-testid="dock-new-tab-more-tools"
                  >
                    <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-left">{t("moreTools")}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
                  {moreTools.map((tool) => (
                    <DropdownMenuItem key={tool.id} onSelect={() => onOpenPanel(tool.id)}>
                      <tool.icon className="size-4" />
                      {tool.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </Section>

        <Section title={t("artifacts")}>
          {artifacts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noArtifacts")}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1 @[28rem]:grid-cols-2">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button
                    type="button"
                    className={cn(ROW_CLASS)}
                    onClick={() => setActiveArtifact(artifact.id, sessionId)}
                    data-testid={`dock-new-tab-artifact-${artifact.id}`}
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {getArtifactTypeIcon(artifact.type, "size-4")}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {desktop || links.length > 0 || chromiumInstalled ? (
          <Section title={t("suggestions")}>
            <div className="flex flex-col gap-3">
              {desktop ? <BrowserLaunchConfigs sessionId={sessionId} onOpen={onOpenPage} /> : null}
              {desktop ? <BrowserLocalContentPicker onOpen={onOpenPage} /> : null}
              {links.length > 0 ? (
                <div className="space-y-1" data-testid="dock-new-tab-links">
                  <p className="text-[11px] text-muted-foreground">{t("taskLinks")}</p>
                  {links.map((url) => (
                    <button
                      key={url}
                      type="button"
                      className={ROW_CLASS}
                      title={url}
                      onClick={() => onOpenPage(url)}
                    >
                      <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {chromiumInstalled ? (
                <button
                  type="button"
                  className={ROW_CLASS}
                  onClick={() => onOpenPage(CHROME_WEB_STORE_URL)}
                  data-testid="dock-new-tab-web-store"
                >
                  <PuzzleIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{t("chromeWebStore")}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {t("chromeWebStoreHint")}
                    </span>
                  </span>
                </button>
              ) : null}
            </div>
          </Section>
        ) : null}

        {/* Settings mode: no page is open for the panel to act on. */}
        <Dialog open={extensionsOpen} onOpenChange={setExtensionsOpen}>
          <DialogContent className="max-w-md p-0" data-testid="dock-new-tab-extensions-dialog">
            <DialogTitle className="sr-only">{t("extensions")}</DialogTitle>
            <BrowserExtensionsPanel backend="local-chromium" />
          </DialogContent>
        </Dialog>

        {recent.length > 0 ? (
          <Section title={t("recent")} icon={HistoryIcon}>
            <ul className="space-y-1" data-testid="dock-new-tab-recent">
              {recent.map((url) => (
                <li key={url}>
                  <button
                    type="button"
                    className={ROW_CLASS}
                    title={url}
                    onClick={() => onOpenPage(url)}
                  >
                    <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{historyLabel(url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </div>
  )
}

const TILE_CLASS =
  "flex h-11 min-w-0 items-center gap-2.5 rounded-lg border bg-card px-3 text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none aria-pressed:border-primary/40 aria-pressed:bg-primary/5"

const ROW_CLASS =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section aria-label={title} className="@container space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
        {title}
      </h3>
      {children}
    </section>
  )
}

function Tile({
  icon: Icon,
  label,
  detail,
  pressed,
  onClick,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  detail?: string
  pressed?: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      className={TILE_CLASS}
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {detail ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {detail}
        </span>
      ) : null}
    </button>
  )
}
