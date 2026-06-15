"use client"

import { Suspense, useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsSidebar } from "./settings-sidebar"
import { SectionResetButton } from "./common/section-reset-button"
import { SettingsFinder } from "./finder/settings-finder"
import { resetKeysForSection } from "@/lib/settings/section-keys"
import { useSettingFocus } from "@/hooks/settings/use-setting-focus"
import { SETTINGS_NAV, type SettingsSectionId } from "./settings-nav-config"

const SectionLoading = () => (
  <div className="space-y-4" aria-busy="true" aria-label="Loading section">
    <Skeleton className="h-7 w-1/3" />
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-32 w-full" />
    <Skeleton className="h-24 w-full" />
  </div>
)

const ApiKeySection = dynamic(() => import("./api-key-section").then((m) => m.ApiKeySection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const ProvidersSection = dynamic(
  () => import("./provider/provider-settings").then((m) => m.ProviderSettings),
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
const SidebarSection = dynamic(
  () => import("./sidebar/sidebar-section").then((m) => m.SidebarSection),
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
const GeneralSection = dynamic(() => import("./general-section").then((m) => m.GeneralSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
const ProfileSection = dynamic(
  () => import("./profile/profile-section").then((m) => m.ProfileSection),
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
const PluginConfigSection = dynamic(
  () => import("./sections/plugin-config-section").then((m) => m.PluginConfigSection),
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
const LogsSection = dynamic(() => import("./sections/logs-section").then((m) => m.LogsSection), {
  ssr: false,
  loading: () => <SectionLoading />,
})
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
const AgentTeamTemplatesSection = dynamic(
  () => import("./agent/agent-team-templates-section").then((m) => m.AgentTeamTemplatesSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const HooksSection = dynamic(() => import("./hooks/hooks-section").then((m) => m.HooksSection), {
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
const ToolSettingsSection = dynamic(
  () => import("./tools/tool-settings-section").then((m) => m.ToolSettingsSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const RemoteControlSection = dynamic(
  () => import("./remote-control/remote-control-section").then((m) => m.RemoteControlSection),
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
const SandboxSection = dynamic(
  () => import("./sandbox/sandbox-section").then((m) => m.SandboxSection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const SecuritySection = dynamic(
  () => import("./security/security-section").then((m) => m.SecuritySection),
  { ssr: false, loading: () => <SectionLoading /> }
)
const GithubDeliverySection = dynamic(
  () => import("./github-delivery/github-delivery-section").then((m) => m.GithubDeliverySection),
  { ssr: false, loading: () => <SectionLoading /> }
)

interface Props {
  /** Renders an actions menu (e.g., Reset/Export/Import) in the header. */
  actions?: React.ReactNode
}

const VALID_SECTIONS = new Set<SettingsSectionId>(SETTINGS_NAV.map((n) => n.id))

// Sections that own a list+detail layout and manage their own internal scroll.
// These bypass the outer ScrollArea so the frame stays fixed while inner panes scroll.
const FILL_HEIGHT_SECTIONS = new Set<SettingsSectionId>(["providers", "ocr", "diagnostics"])

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
  const [finderOpen, setFinderOpen] = useState(false)

  useSettingFocus()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setFinderOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const requested = searchParams.get("section")
  const activeSection: SettingsSectionId = isSection(requested) ? requested : "general"

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
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 z-10 sm:h-12">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 sm:h-8 sm:w-8"
            onClick={goHome}
            aria-label={t("backToChat")}
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <SidebarTrigger />
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <h1 className="text-base font-semibold">{t("title")}</h1>
            {activeItem && (
              <>
                <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-base text-muted-foreground truncate">
                  {t(`tabs.${activeItem.labelKey}` as never)}
                </span>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setFinderOpen(true)}
            aria-label={t("finder.triggerAria")}
            data-testid="settings-finder-trigger"
          >
            <SearchIcon className="h-4 w-4" />
          </Button>
          {actions}
        </header>

        <SettingsFinder open={finderOpen} onOpenChange={setFinderOpen} />

        {FILL_HEIGHT_SECTIONS.has(activeSection) ? (
          <div
            className="flex flex-1 min-h-0 flex-col p-3 sm:p-4 md:p-5 lg:p-6 safe-area-pb"
            data-settings-panel
          >
            <div className="mx-auto flex w-full min-h-0 flex-1 flex-col animate-in fade-in slide-in-from-bottom-2 duration-200">
              {hasSectionReset && (
                <div className="mb-3 flex shrink-0 justify-end" data-testid="section-reset-row">
                  <SectionResetButton sectionId={activeSection} />
                </div>
              )}
              <SectionContent section={activeSection} onClose={goHome} />
            </div>
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3 sm:p-4 md:p-5 lg:p-6 safe-area-pb" data-settings-panel>
              <div className="mx-auto w-full max-w-5xl animate-in fade-in slide-in-from-bottom-2 duration-200">
                {hasSectionReset && (
                  <div className="mb-3 flex justify-end" data-testid="section-reset-row">
                    <SectionResetButton sectionId={activeSection} />
                  </div>
                )}
                <SectionContent section={activeSection} onClose={goHome} />
              </div>
            </div>
          </ScrollArea>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

function SectionContent({ section, onClose }: { section: SettingsSectionId; onClose: () => void }) {
  switch (section) {
    case "general":
      return <GeneralSection onClose={onClose} />
    case "profile":
      return <ProfileSection />
    case "api-key":
      return <ApiKeySection />
    case "providers":
      return <ProvidersSection />
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
    case "agent-teams":
      return <AgentTeamTemplatesSection />
    case "hooks":
      return <HooksSection />
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
      return <SidebarSection />
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
    case "artifacts":
      return <ArtifactsSection />
    case "canvas":
      return <CanvasSection />
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
    case "plugin-config":
      return <PluginConfigSection />
    case "connections":
      return <ConnectionsSection />
    case "github-delivery":
      return <GithubDeliverySection />
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
    case "remote-control":
      return <RemoteControlSection />
    case "gateway":
      return <GatewaySection />
    case "external-bridge":
      return <ExternalBridgeSection />
    case "automation":
      return <AutomationSection />
    case "lsp":
      return <LspServersSection />
    case "sandbox":
      return <SandboxSection />
    case "security":
      return <SecuritySection />
    case "companion":
      return <CompanionSection />
    case "network":
      return <NetworkSection />
    case "logs":
      return <LogsSection onClose={onClose} />
    case "diagnostics":
      return <DiagnosticsSection />
    case "desktop":
      return <DesktopSection />
    case "about":
      return <AboutSection />
    default:
      return <GeneralSection onClose={onClose} />
  }
}

function SettingsShellFallback() {
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center text-sm text-muted-foreground">
      Loading settings…
    </div>
  )
}
