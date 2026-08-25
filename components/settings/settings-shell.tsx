"use client"

import { Suspense, useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, ChevronRightIcon, MonitorIcon, SearchIcon } from "lucide-react"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { SettingsSidebar } from "./settings-sidebar"
import { SectionResetButton } from "./common/section-reset-button"
import { SettingsEmptyState } from "./common/settings-section"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { resetKeysForSection } from "@/lib/settings/section-keys"
import { useSettingsSectionReachability } from "@/hooks/settings/use-settings-section-reachability"
import { useSettingFocus } from "@/hooks/settings/use-setting-focus"
import { SETTINGS_NAV, type SettingsSectionId } from "./settings-nav-config"

const SectionLoading = () => {
  const t = useTranslations("settings")
  return (
    <div className="space-y-4" aria-busy="true" aria-label={t("loadingSection")}>
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

const ProvidersSection = dynamic(
  () => import("./provider/provider-settings").then((m) => m.ProviderSettings),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ModelCatalogSection = dynamic(
  () => import("./provider/model-catalog-section").then((m) => m.ModelCatalogSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SearchSettings = dynamic(
  () => import("./search/search-settings").then((m) => m.SearchSettings),
  { ssr: false, loading: () => <SectionLoading /> }
)
const OcrSection = dynamic(
  () => import("./ocr/ocr-section-persisted").then((m) => m.OcrSectionPersisted),
  {
    ssr: false,
    loading: () => <SectionLoading />,
  }
)
const AppearanceSection = dynamic(() => import("./appearance").then((m) => m.AppearanceSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const ShellLayoutSection = dynamic(
  () => import("./sidebar/shell-layout-section").then((m) => m.ShellLayoutSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const DiscoverSection = dynamic(
  () => import("./discover/discover-section").then((m) => m.DiscoverSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const CharactersSection = dynamic(
  () => import("./characters-section").then((m) => m.CharactersSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const TeamsSection = dynamic(() => import("./teams-section").then((m) => m.TeamsSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const ChatTemplatesSection = dynamic(
  () => import("./chat-templates-section").then((m) => m.ChatTemplatesSection),
  { ssr: false }
)
const PromptPresetsSection = dynamic(
  () => import("./prompt-presets-section").then((m) => m.PromptPresetsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const McpServersSection = dynamic(
  () => import("./mcp-servers-section").then((m) => m.McpServersSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const DataSection = dynamic(() => import("./data/data-section").then((m) => m.DataSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const ScheduledTasksSection = dynamic(
  () => import("./scheduled-tasks-section").then((m) => m.ScheduledTasksSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const DesktopSection = dynamic(() => import("./desktop-section").then((m) => m.DesktopSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const AboutSection = dynamic(() => import("./about/about-section").then((m) => m.AboutSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const AccountOverviewSection = dynamic(
  () => import("./account/account-overview-section").then((m) => m.AccountOverviewSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const A2UISection = dynamic(() => import("./a2ui-section").then((m) => m.A2UISection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const PluginsSection = dynamic(
  () => import("./sections/plugins-section").then((m) => m.PluginsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SkillsSection = dynamic(
  () => import("./sections/skills-section").then((m) => m.SkillsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SpeechSection = dynamic(() => import("./speech-section").then((m) => m.SpeechSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const TerminalSection = dynamic(
  () => import("./terminal/terminal-section").then((m) => m.TerminalSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const LogsSection = dynamic(() => import("./logs/logs-section").then((m) => m.LogsSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const UsageCostSection = dynamic(
  () => import("./sections/usage-cost-section").then((m) => m.UsageCostSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const DiagnosticsSection = dynamic(
  () => import("./sections/diagnostics-section").then((m) => m.DiagnosticsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ExternalAgentSettings = dynamic(() => import("./agent/external-agent-settings"), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const CustomModeSettings = dynamic(
  () => import("./agent/custom-mode-settings").then((m) => m.CustomModeSettings),
  { ssr: false, loading: () => <SectionLoading /> }
)
const AgentRuntimeSection = dynamic(
  () => import("./agent-runtime/agent-runtime-section").then((m) => m.AgentRuntimeSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SquadsSection = dynamic(
  () => import("./squads/squads-section").then((m) => m.SquadsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const HooksSection = dynamic(() => import("./hooks/hooks-section").then((m) => m.HooksSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const FleetSection = dynamic(() => import("./fleet/fleet-section").then((m) => m.FleetSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const WorkspaceTrustSection = dynamic(
  () => import("./workspace-trust/workspace-trust-section").then((m) => m.WorkspaceTrustSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SubagentsSection = dynamic(
  () => import("./subagents/subagents-section").then((m) => m.SubagentsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SlashCommandsSection = dynamic(
  () => import("./slash-commands/slash-commands-section").then((m) => m.SlashCommandsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ArtifactsSection = dynamic(
  () => import("./artifacts-section").then((m) => m.ArtifactsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const CanvasSection = dynamic(() => import("./canvas-section").then((m) => m.CanvasSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const UnifiedShortcutsSection = dynamic(
  () => import("./shortcuts/unified-shortcuts-section").then((m) => m.UnifiedShortcutsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ToolSettingsSection = dynamic(
  () => import("./tools/tool-settings-section").then((m) => m.ToolSettingsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const WebhooksSection = dynamic(
  () => import("./webhooks/webhooks-section").then((module) => module.WebhooksSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const GatewaySection = dynamic(
  () => import("./gateway/gateway-section").then((m) => m.GatewaySection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ExternalBridgeSection = dynamic(
  () => import("./external-bridge/external-bridge-section").then((m) => m.ExternalBridgeSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const AutomationSection = dynamic(
  () => import("./automation/automation-section").then((m) => m.AutomationSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const CompanionSection = dynamic(
  () => import("./companion/companion-section").then((m) => m.CompanionSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const RemoteHostsSection = dynamic(
  () => import("./remote-hosts/remote-hosts-section").then((m) => m.RemoteHostsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const CcswitchSection = dynamic(
  () => import("./ccswitch/ccswitch-section").then((m) => m.CcswitchSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SubscriptionSection = dynamic(
  () => import("./subscription/subscription-section").then((m) => m.SubscriptionSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ConnectionsSection = dynamic(
  () => import("./connections/connections-section").then((m) => m.ConnectionsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ExternalServicesSection = dynamic(
  () =>
    import("./external-services/external-services-section").then((m) => m.ExternalServicesSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const NetworkSection = dynamic(
  () => import("./network/network-section").then((m) => m.NetworkSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const WorkflowsSection = dynamic(
  () => import("./workflows/workflows-section").then((m) => m.WorkflowsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const GoalsSection = dynamic(() => import("./goals/goals-section").then((m) => m.GoalsSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const EvalSettingsSection = dynamic(
  () => import("./eval/eval-settings-section").then((m) => m.EvalSettingsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const PetSection = dynamic(() => import("./pet/pet-section").then((m) => m.PetSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const ConversationSection = dynamic(
  () => import("./conversation/conversation-section").then((m) => m.ConversationSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const NotificationsSection = dynamic(
  () => import("./notifications/notifications-section").then((m) => m.NotificationsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const MemorySection = dynamic(
  () => import("./sections/memory-section").then((m) => m.MemorySection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const GitSection = dynamic(() => import("./source-control/git-section").then((m) => m.GitSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const LspServersSection = dynamic(
  () => import("./lsp/lsp-servers-section").then((m) => m.LspServersSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const ProIdeSection = dynamic(
  () => import("./pro-ide/pro-ide-section").then((m) => m.ProIdeSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SandboxSection = dynamic(
  () => import("./sandbox/sandbox-section").then((m) => m.SandboxSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SecuritySection = dynamic(
  () => import("./security/security-section").then((m) => m.SecuritySection),
  { ssr: false, loading: () => <SectionLoading /> }
)
interface Props {
  /** Renders an actions menu (e.g., Reset/Export/Import) in the header. */
  actions?: React.ReactNode
}

const VALID_SECTIONS = new Set<SettingsSectionId>(SETTINGS_NAV.map((n) => n.id))

// Deprecated sections folded into others (the standalone "general", "api-key",
// and "profile" pages were merged into agent-runtime / providers / account).
// Old deep links (`?section=general`, `?section=api-key`, `?section=profile`)
// transparently redirect to the new home so bookmarks and finder anchors don't
// break. (The account section embeds the profile editor.)
const DEPRECATED_REDIRECT: Record<string, SettingsSectionId> = {
  general: "agent-runtime",
  "api-key": "ai-connections",
  providers: "ai-connections",
  profile: "account",
}

/** Default landing section when the URL has no (valid) `?section=`. */
const DEFAULT_SECTION: SettingsSectionId = "ai-connections"

// Sections that own a list+detail layout and manage their own internal scroll.
// These bypass the outer ScrollArea so the frame stays fixed while inner panes scroll.
const FILL_HEIGHT_SECTIONS = new Set<SettingsSectionId>([
  "ai-connections",
  "model-catalog",
  "ocr",
  "diagnostics",
  "connections",
  "skills",
  "hooks",
  "agents",
  "search",
  "appearance",
  "subscription",
  "subagents",
  // Same conversion as Subagents: a rail plus a detail pane, both owning their
  // own scroll. Left out of this set it renders capped at max-w-5xl with the
  // two fighting over 1024px and the page, not the pane, doing the scrolling.
  "squads",
  // Both became master/detail panes that own their own scroll; in the capped
  // ScrollArea branch they would render at max-w-5xl with the nav rail and the
  // detail pane fighting over 1024px.
  "gateway",
  "external-bridge",
  // Same conversion, same reason. Left out of this set they still *rendered* —
  // `h-full` collapsed to content height inside the ScrollArea, so the rail and
  // the pane grew unbounded and the whole page scrolled instead of the pane.
  // That is the visible difference from Providers: capped width, wasted page,
  // outer scrollbar.
  "agent-modes",
  "agent-runtime",
  "memory",
  // Same conversion again: the MCP panel is now a master/detail pane that owns
  // its own scroll, so the capped-width ScrollArea branch would waste the
  // window and stack a second scrollbar on it.
  "mcp",
  "logs",
])

function isSection(value: string | null): value is SettingsSectionId {
  return value !== null && VALID_SECTIONS.has(value as SettingsSectionId)
}

export function SettingsShell({ actions }: Props = {}) {
  return (
    <Suspense fallback={<SettingsShellFallback />}>
      <SettingsShellInner actions={actions} />
    </Suspense>
  )
}

function SettingsShellInner({ actions }: Props) {
  const t = useTranslations("settings")
  const router = useRouter()
  const searchParams = useSearchParams()
  const [searchQuery, setSearchQuery] = useState("")
  const [sectionHeaderActionsTarget, setSectionHeaderActionsTarget] =
    useState<HTMLDivElement | null>(null)

  useSettingFocus()

  // ⌘/Ctrl+K belongs to the unified global search (ADR-0129); its settings
  // provider carries every reachable section and finder control, so the
  // header trigger just opens it pre-scoped to settings.
  const openSettingsFinder = () => requestCommandPalette({ query: "in:settings ", scope: "pages" })

  const requested = searchParams.get("section")
  const redirectTarget = requested ? DEPRECATED_REDIRECT[requested] : undefined
  const activeSection: SettingsSectionId = isSection(requested)
    ? requested
    : (redirectTarget ?? DEFAULT_SECTION)

  // Rewrite deprecated `?section=` deep links to their new home. Done in an
  // effect (router writes can't happen during render); the body already
  // renders `redirectTarget` so there's no flash of the wrong section.
  useEffect(() => {
    if (!redirectTarget) return
    const next = new URLSearchParams(searchParams.toString())
    next.set("section", redirectTarget)
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }, [redirectTarget, router, searchParams])

  const handleSectionSelect = (section: SettingsSectionId) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("section", section)
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }

  const goHome = () => router.push("/")

  const activeItem = SETTINGS_NAV.find((item) => item.id === activeSection)
  const hasSectionReset = Boolean(resetKeysForSection(activeSection))

  return (
    <SidebarProvider
      defaultOpen
      data-bg-target="chat"
      className="flex h-full min-h-0 flex-1 overflow-hidden safe-area-pt"
      style={{ "--sidebar-width": "15rem" } as React.CSSProperties}
    >
      <SettingsSidebar
        activeSection={activeSection}
        onSelect={handleSectionSelect}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <SidebarInset data-bg-target="chat" className="flex flex-col min-w-0 h-full overflow-hidden">
        <FeaturePageHeader
          variant="compact"
          icon={<MonitorIcon />}
          title={
            <span className="flex min-w-0 items-center gap-1.5">
              <span>{t("title")}</span>
              {activeItem && (
                <>
                  <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate font-normal text-muted-foreground">
                    {t(`tabs.${activeItem.labelKey}` as never)}
                  </span>
                </>
              )}
            </span>
          }
          breadcrumb={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={goHome}
                aria-label={t("backToChat")}
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
              <SidebarTrigger />
            </div>
          }
          actions={
            <>
              {activeSection === "ai-connections" && (
                <div
                  ref={setSectionHeaderActionsTarget}
                  className="contents"
                  data-testid="settings-section-header-actions"
                />
              )}
              {hasSectionReset && <SectionResetButton sectionId={activeSection} />}
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={openSettingsFinder}
                aria-label={t("finder.triggerAria")}
                data-testid="settings-finder-trigger"
              >
                <SearchIcon className="size-4" />
              </Button>
              {actions}
            </>
          }
        />

        {FILL_HEIGHT_SECTIONS.has(activeSection) ? (
          <div
            className="flex min-h-0 w-full max-w-[100vw] min-w-0 flex-1 flex-col overflow-hidden p-3 sm:p-4 md:p-5 lg:p-6 safe-area-pb"
            data-settings-panel
          >
            <div className="mx-auto flex w-full min-h-0 flex-1 flex-col animate-in fade-in slide-in-from-bottom-2 duration-200">
              <SectionContent
                section={activeSection}
                onClose={goHome}
                headerActionsTarget={sectionHeaderActionsTarget}
              />
            </div>
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0">
            <div
              className="w-full max-w-[100vw] min-w-0 p-3 sm:p-4 md:p-5 lg:p-6 safe-area-pb"
              data-settings-panel
            >
              <div className="mx-auto w-full max-w-5xl animate-in fade-in slide-in-from-bottom-2 duration-200">
                <SectionContent
                  section={activeSection}
                  onClose={goHome}
                  headerActionsTarget={sectionHeaderActionsTarget}
                />
              </div>
            </div>
          </ScrollArea>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

function SectionContent({
  section,
  onClose,
  headerActionsTarget,
}: {
  section: SettingsSectionId
  onClose: () => void
  headerActionsTarget: HTMLDivElement | null
}) {
  const t = useTranslations("settings")
  const { isReachable } = useSettingsSectionReachability()

  // Last line of defence for sections this host can't reach. The sidebar and
  // the finder both hide them, but `?section=` is a public deep-link contract
  // (bookmarks, docs, finder anchors), so the dispatch itself has to refuse —
  // otherwise the panel renders and the user only discovers it can't work when
  // an IPC call rejects at the end of a multi-step flow. An explicit
  // explanation beats a silent redirect: the user asked for this section.
  if (!isReachable(section)) {
    return (
      <SettingsEmptyState
        icon={<MonitorIcon />}
        title={t("hostUnavailableSectionTitle")}
        description={t("hostUnavailableSectionBody")}
      />
    )
  }

  switch (section) {
    case "account":
      return <AccountOverviewSection />
    case "ai-connections":
      return <ProvidersSection headerActionsTarget={headerActionsTarget} />
    case "model-catalog":
      return <ModelCatalogSection />
    case "subscription":
      return <SubscriptionSection />
    case "ccswitch":
      return <CcswitchSection />
    case "agents":
      return <ExternalAgentSettings />
    case "agent-modes":
      return <CustomModeSettings />
    case "agent-runtime":
      return <AgentRuntimeSection />
    case "squads":
      return <SquadsSection />
    case "eval":
      return <EvalSettingsSection />
    case "hooks":
      return <HooksSection />
    case "fleet":
      return <FleetSection />
    case "workspace-trust":
      return <WorkspaceTrustSection />
    case "slash-commands":
      return <SlashCommandsSection />
    case "tools":
      return <ToolSettingsSection />
    case "search":
      return <SearchSettings />
    case "ocr":
      return <OcrSection />
    case "appearance":
      return <AppearanceSection />
    case "sidebar":
      return <ShellLayoutSection />
    case "discover":
      return <DiscoverSection />
    case "terminal":
      return <TerminalSection />
    case "source-control":
      return <GitSection />
    case "speech":
      return <SpeechSection />
    case "characters":
      return <CharactersSection />
    case "skills":
      return <SkillsSection />
    case "subagents":
      return <SubagentsSection />
    case "teams":
      return <TeamsSection />
    case "presets":
      return <PromptPresetsSection />
    case "chatTemplates":
      return <ChatTemplatesSection />
    case "artifacts":
      return <ArtifactsSection />
    case "canvas":
      return <CanvasSection />
    case "shortcuts":
      return <UnifiedShortcutsSection />
    case "conversation":
      return <ConversationSection />
    case "notifications":
      return <NotificationsSection />
    case "memory":
      return <MemorySection />
    case "mcp":
      return <McpServersSection />
    case "a2ui":
      return <A2UISection />
    case "plugins":
      return <PluginsSection onClose={onClose} />
    case "connections":
      return <ConnectionsSection />
    case "services":
      return <ExternalServicesSection />
    case "data":
      return <DataSection />
    case "workflows":
      return <WorkflowsSection />
    case "scheduled-tasks":
      return <ScheduledTasksSection />
    case "goals":
      return <GoalsSection />
    case "pet":
      return <PetSection />
    case "webhooks":
      return <WebhooksSection />
    case "gateway":
      return <GatewaySection />
    case "external-bridge":
      return <ExternalBridgeSection />
    case "automation":
      return <AutomationSection />
    case "lsp":
      return <LspServersSection />
    case "pro-ide":
      return <ProIdeSection />
    case "sandbox":
      return <SandboxSection />
    case "security":
      return <SecuritySection />
    case "companion":
      return <CompanionSection />
    case "remote-hosts":
      return <RemoteHostsSection />
    case "network":
      return <NetworkSection />
    case "logs":
      return <LogsSection onClose={onClose} />
    case "diagnostics":
      return <DiagnosticsSection />
    case "usage-cost":
      return <UsageCostSection />
    case "desktop":
      return <DesktopSection />
    case "about":
      return <AboutSection />
    default:
      return <ProvidersSection headerActionsTarget={headerActionsTarget} />
  }
}

function SettingsShellFallback() {
  const t = useTranslations("settings")
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center text-sm text-muted-foreground">
      {t("loadingSettings")}
    </div>
  )
}
