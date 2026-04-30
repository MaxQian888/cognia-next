"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, XIcon } from "lucide-react"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SettingsSidebar } from "./settings-sidebar"
import { SETTINGS_NAV, type SettingsSectionId } from "./settings-nav-config"
import { ApiKeySection } from "./api-key-section"
import { SearchSettings } from "./search/search-settings"
import { AppearanceSection } from "./appearance-section"
import { CharactersSection } from "./characters-section"
import { TeamsSection } from "./teams-section"
import { PromptPresetsSection } from "./prompt-presets-section"
import { McpServersSection } from "./mcp-servers-section"
import { DataSection } from "./data/data-section"
import { ScheduledTasksSection } from "./scheduled-tasks-section"
import { DesktopSection } from "./desktop-section"
import { AboutSection } from "./about-section"
import { GeneralSection } from "./general-section"
import { SkillsLinkCard } from "./sections/skills-link-card"
import { SpeechSection } from "./speech-section"
import { LogsSection } from "./sections/logs-section"
import { DiagnosticsSection } from "./sections/diagnostics-section"
import ExternalAgentSettings from "./agent/external-agent-settings"
import { CustomModeSettings } from "./agent/custom-mode-settings"
import { ArtifactsSection } from "./artifacts-section"
import { CanvasSection } from "./canvas-section"

interface Props {
  /** Initial section to render. Updated when the URL `?section=` changes. */
  defaultSection?: SettingsSectionId
  /**
   * When set, the shell renders without a top-of-page <html> wrapper or
   * back-to-home button — used inside the settings Sheet host.
   */
  embedded?: boolean
  /** Optional handler for the close (×) button when embedded inside a sheet. */
  onClose?: () => void
  /** Renders an actions menu (e.g., Reset/Export/Import) in the header. */
  actions?: React.ReactNode
}

const VALID_SECTIONS = new Set<SettingsSectionId>(SETTINGS_NAV.map((n) => n.id))

function isSection(value: string | null): value is SettingsSectionId {
  return value !== null && VALID_SECTIONS.has(value as SettingsSectionId)
}

export function SettingsShell({
  defaultSection = "general",
  embedded = false,
  onClose,
  actions,
}: Props) {
  return (
    <Suspense fallback={<SettingsShellFallback />}>
      <SettingsShellInner
        defaultSection={defaultSection}
        embedded={embedded}
        onClose={onClose}
        actions={actions}
      />
    </Suspense>
  )
}

function SettingsShellInner({
  defaultSection,
  embedded,
  onClose,
  actions,
}: Required<Pick<Props, "defaultSection" | "embedded">> & Pick<Props, "onClose" | "actions">) {
  const t = useTranslations("settings")
  const [searchQuery, setSearchQuery] = useState("")
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(defaultSection)

  // Hydrate from URL `?section=` when running as a real route. In embedded
  // mode the host owns the section (passed in via defaultSection).
  useEffect(() => {
    if (embedded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveSection(defaultSection)
      return
    }
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const requested = params.get("section")
    if (isSection(requested)) {
      setActiveSection(requested)
    }
  }, [defaultSection, embedded])

  const handleSectionSelect = (section: SettingsSectionId) => {
    setActiveSection(section)
    if (!embedded && typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("section", section)
      window.history.replaceState({}, "", url.toString())
    }
  }

  const activeItem = useMemo(
    () => SETTINGS_NAV.find((item) => item.id === activeSection),
    [activeSection]
  )

  return (
    <SidebarProvider
      defaultOpen
      className={cn("flex h-full overflow-hidden", embedded ? "min-h-[600px]" : "h-svh")}
      style={{ "--sidebar-width": "16rem" } as React.CSSProperties}
    >
      <SettingsSidebar
        activeSection={activeSection}
        onSelect={handleSectionSelect}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <SidebarInset className="flex flex-col min-w-0 h-full overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3 z-10">
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
          {actions}
          {embedded && onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClose}
              aria-label={t("close")}
            >
              <XIcon className="h-4 w-4" />
            </Button>
          )}
        </header>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 lg:p-6" data-settings-panel>
            <div className="mx-auto max-w-5xl animate-in fade-in slide-in-from-bottom-2 duration-200">
              <SectionContent section={activeSection} onClose={onClose ?? (() => {})} />
            </div>
          </div>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  )
}

function SectionContent({ section, onClose }: { section: SettingsSectionId; onClose: () => void }) {
  switch (section) {
    case "general":
      return <GeneralSection onClose={onClose} />
    case "api-key":
      return <ApiKeySection />
    case "agents":
      return <ExternalAgentSettings />
    case "agent-modes":
      return <CustomModeSettings />
    case "search":
      return <SearchSettings />
    case "appearance":
      return <AppearanceSection />
    case "speech":
      return <SpeechSection />
    case "characters":
      return <CharactersSection />
    case "skills":
      return <SkillsLinkCard onClose={onClose} />
    case "teams":
      return <TeamsSection />
    case "presets":
      return <PromptPresetsSection />
    case "artifacts":
      return <ArtifactsSection />
    case "canvas":
      return <CanvasSection />
    case "mcp":
      return <McpServersSection />
    case "data":
      return <DataSection />
    case "scheduled-tasks":
      return <ScheduledTasksSection />
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
