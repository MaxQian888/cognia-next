"use client"

// /plugins panel — main user-facing surface for plugin management.
//
// 3-pane shell powered by `FeaturePageShell`:
//   - **Left**  PluginNavSidebar (Library / Discover / Governance /
//               Devtools — Devtools gated by `useDevtoolsGate`)
//   - **Center** Switches on `activeSection`: Library / Discover /
//               Governance / Devtools panes
//   - **Right** Persistent `PluginDetailPane` showing the selected plugin's
//               5-tab detail (Overview / Capabilities / Configure /
//               Permissions / Data). On narrow viewports the right pane
//               collapses into FeaturePageShellMobile's Sheet trigger.
//
// Dialog hosts (delete, permission review, import, conflict, update,
// rollback) are mounted once at the root.
//
// URL deep links: `?section=` / `?sub=` / `?gov=` / `?subtab=` drive the
// layout. Legacy `?tab=` deep links are translated once to the canonical
// section vocabulary via `router.replace` (see `TAB_REDIRECT`), so old
// external links keep landing on the right view without a parallel store
// concept.

import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import {
  usePluginsStore,
  type PluginDetailSubTab,
  type PluginGovernanceView,
  type PluginLibrarySubFilter,
  type PluginNavSection,
} from "@/stores/plugins"
import { usePluginMarketplace, usePluginRegistrySync, PluginsViewProvider } from "@/hooks/plugins"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlugIcon } from "lucide-react"

import { PLUGIN_RAIL_WIDTH } from "./plugin-rail-width"

// Dialog hosts — all driven by store targets, mounted once at the panel root.
import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { PluginFilterSheet } from "./dialogs/plugin-filter-sheet"
import { PluginDeleteDialogHost } from "./dialogs/plugin-delete-dialog-host"
import { PluginPermissionReview } from "./plugin-permission-review"
import { PluginImportDialog } from "./dialogs/plugin-import-dialog"
import { PluginConflictDialog } from "./dialogs/plugin-conflict-dialog"
import { PluginUpdateDialog } from "./dialogs/plugin-update-dialog"
import { PluginRollbackDialog } from "./dialogs/plugin-rollback-dialog"
import { PluginExtensionSlot } from "./plugin-extension-slot"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"

// 3-pane shell pieces.
import { PluginNavSidebar } from "./plugin-nav-sidebar"
import { PluginPanelToolbar } from "./plugin-panel-toolbar"
import { PluginDetailPane } from "./detail/plugin-detail-pane"
import {
  PluginSectionControls,
  PluginSectionPane,
  pluginSectionHasControls,
  useVisiblePluginSection,
} from "./plugin-section-pane"
import { useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

// One-time translation of legacy `?tab=` deep links into the canonical
// `?section=/&sub=/&gov=/&subtab=` vocabulary. The redirect rewrites the URL
// and the section/sub/gov/subtab effect below applies it to the store.
const TAB_REDIRECT: Record<
  string,
  {
    section: PluginNavSection
    sub?: PluginLibrarySubFilter
    gov?: PluginGovernanceView
    subtab?: PluginDetailSubTab
  }
> = {
  installed: { section: "library" },
  browse: { section: "discover" },
  configure: { section: "library", sub: "configurable", subtab: "configure" },
  permissions: { section: "governance", gov: "permissions" },
  scheduled: { section: "governance", gov: "scheduled" },
  analytics: { section: "governance", gov: "analytics" },
  devtools: { section: "devtools" },
}

const VALID_SECTIONS: ReadonlySet<PluginNavSection> = new Set([
  "library",
  "discover",
  "agent-packages",
  "governance",
  "devtools",
])
const VALID_LIBRARY_SUB: ReadonlySet<PluginLibrarySubFilter> = new Set([
  "all",
  "enabled",
  "updates",
  "configurable",
  "errored",
])
const VALID_GOVERNANCE: ReadonlySet<PluginGovernanceView> = new Set([
  "permissions",
  "scheduled",
  "analytics",
  "audit",
  "policy",
])
const VALID_DETAIL_SUBTAB: ReadonlySet<PluginDetailSubTab> = new Set([
  "overview",
  "capabilities",
  "configure",
  "permissions",
  "data",
])

function isValidSection(value: string | null): value is PluginNavSection {
  return value !== null && VALID_SECTIONS.has(value as PluginNavSection)
}

export function PluginPanel() {
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const setLibrarySubFilter = usePluginsStore((s) => s.setLibrarySubFilter)
  const setGovernanceView = usePluginsStore((s) => s.setGovernanceView)
  const setDetailSubTab = usePluginsStore((s) => s.setDetailSubTab)
  const developerMode = useDeveloperMode()
  const tPage = useTranslations("plugins")

  // URL sync — `?section=`, `?sub=`, `?gov=`, `?subtab=` drive the layout.
  // We adopt the URL value on mount AND whenever the URL changes; local
  // clicks don't touch the URL, so this effect stays a no-op for in-app
  // navigation.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const requestedTabParam = searchParams?.get("tab") ?? null
  const requestedSectionParam = searchParams?.get("section") ?? null
  const requestedSubParam = searchParams?.get("sub") ?? null
  const requestedGovParam = searchParams?.get("gov") ?? null
  const requestedSubtabParam = searchParams?.get("subtab") ?? null

  // Legacy `?tab=` → canonical params, then strip `tab`. The section effect
  // below picks up the rewritten URL.
  useEffect(() => {
    if (!requestedTabParam) return
    const mapped = TAB_REDIRECT[requestedTabParam]
    if (!mapped) return
    const next = new URLSearchParams(searchParams?.toString() ?? "")
    next.delete("tab")
    next.set("section", mapped.section)
    if (mapped.sub) next.set("sub", mapped.sub)
    if (mapped.gov) next.set("gov", mapped.gov)
    if (mapped.subtab) next.set("subtab", mapped.subtab)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTabParam])

  useEffect(() => {
    if (requestedSectionParam === "devtools" && !developerMode) {
      setActiveSection("library")
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      next.set("section", "library")
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
      toast.message(tPage("devtoolsDisabled.title"), {
        description: tPage("devtoolsDisabled.description"),
        action: {
          label: tPage("devtoolsDisabled.openSettings"),
          onClick: () => router.push("/settings?section=plugins"),
        },
      })
      return
    }
    if (isValidSection(requestedSectionParam)) {
      setActiveSection(requestedSectionParam)
    }
    if (
      requestedSubParam !== null &&
      VALID_LIBRARY_SUB.has(requestedSubParam as PluginLibrarySubFilter)
    ) {
      setLibrarySubFilter(requestedSubParam as PluginLibrarySubFilter)
    }
    if (
      requestedGovParam !== null &&
      VALID_GOVERNANCE.has(requestedGovParam as PluginGovernanceView)
    ) {
      setGovernanceView(requestedGovParam as PluginGovernanceView)
    }
    if (
      requestedSubtabParam !== null &&
      VALID_DETAIL_SUBTAB.has(requestedSubtabParam as PluginDetailSubTab)
    ) {
      setDetailSubTab(requestedSubtabParam as PluginDetailSubTab)
    }
  }, [
    requestedSectionParam,
    requestedSubParam,
    requestedGovParam,
    requestedSubtabParam,
    developerMode,
    pathname,
    router,
    searchParams,
    setActiveSection,
    setDetailSubTab,
    setGovernanceView,
    setLibrarySubFilter,
    tPage,
  ])

  const [updateOpen, setUpdateOpen] = useState(false)
  const rollbackTarget = usePluginsStore((s) => s.rollbackTarget)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)

  // The panel only needs the imperative `refresh()` for the Sync Registry
  // button, it never renders search/featured results itself. Opt out of the
  // on-mount auto-search so entering /plugins from the sidebar (which lands on
  // the Library section) doesn't fire a marketplace search. The Discover /
  // marketplace surfaces keep their own auto-loading hook instances.
  const market = usePluginMarketplace({ autoLoad: false })
  const { syncing, sync } = usePluginRegistrySync(market.refresh)

  const dialogHosts = (
    <>
      <PluginPermissionReview />
      <PluginDeleteDialogHost />
      <PluginImportDialog />
      <PluginConflictDialog />
      <PluginUpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
      <PluginRollbackDialog
        open={rollbackTarget !== null}
        pluginId={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
      />
      <PluginFilterSheet />
      <PluginBatchActionsBar />
    </>
  )

  return (
    <PluginsViewProvider>
      {dialogHosts}
      <NewShellLayout
        onCheckUpdates={() => setUpdateOpen(true)}
        onSyncRegistry={sync}
        syncing={syncing}
      />
    </PluginsViewProvider>
  )
}

interface NewShellLayoutProps {
  onCheckUpdates: () => void
  onSyncRegistry: () => Promise<void>
  syncing: boolean
}

function NewShellLayout({ onCheckUpdates, onSyncRegistry, syncing }: NewShellLayoutProps) {
  const t = useTranslations("plugins.sections")
  const tPage = useTranslations("plugins")
  const activeSection = usePluginsStore((s) => s.activeSection)
  const visibleSection = useVisiblePluginSection(activeSection)

  // Second header tier — one control vocabulary for every section. Each
  // section supplies its own segments/tools through `PluginSectionToolbar`
  // rather than inventing a picker of its own (see that component's note).
  // The mapping itself lives in `plugin-section-pane.tsx` so the phone body
  // renders the same sections from the same source.
  const controls = pluginSectionHasControls(visibleSection) ? (
    <PluginSectionControls section={visibleSection} />
  ) : undefined

  return (
    <FeaturePageShell
      storageId="plugins"
      header={
        <FeaturePageHeader
          icon={<PlugIcon />}
          title={tPage("title")}
          description={tPage("description")}
          context={t(visibleSection)}
          controls={controls}
          actions={
            visibleSection === "library" ? (
              <PluginPanelToolbar
                onCheckUpdates={onCheckUpdates}
                onSyncRegistry={onSyncRegistry}
                syncing={syncing}
              />
            ) : undefined
          }
        />
      }
      leftPane={{
        label: t("library"),
        content: <PluginNavSidebar />,
        // Pinned, not proportional. Its rows are short labels ("已安装" /
        // Discover / Governance), so a percentage column grows with the window
        // for no reason and, worse, drifts away from the Library's capability
        // rail immediately to its right, which is a fixed Tailwind width. One
        // constant in the unit both mechanisms accept keeps the two rails equal
        // at every window size. The bounds are lengths too: a percentage max
        // would clamp the pinned default below itself on a narrow window.
        defaultSize: PLUGIN_RAIL_WIDTH,
        minSize: "10rem",
        maxSize: "20rem",
      }}
      // Library / Discover / Governance all keep the right pane mounted, so
      // moving between them never changes the pane count and never discards
      // the split the user dragged. Governance's aggregate views are
      // per-plugin rows, so the same detail pane is the right target for
      // them. Devtools is still 2-pane — its diagnostics grid needs the full
      // width and gets its own right-pane content in a later step. Agent
      // Packages is 2-pane for a different reason: its rows are Pi packages,
      // which have no row in the plugins table, so the detail pane would have
      // nothing to show for whatever is selected there.
      rightPane={
        visibleSection === "devtools" || visibleSection === "agent-packages"
          ? undefined
          : {
              label: t("detailSheetLabel"),
              // README-centric detail reads better with width, but not at the
              // center pane's expense: at 46% the center sat around 39% (~460
              // to 560px at 1440), which is below the `@xl` container gate the
              // library's capability rail and its rows' capability chips are
              // written against. The rail was therefore unreachable at the
              // default split on a normal desktop, and the row degraded to
              // name/version/status. 34% keeps the README comfortable while
              // leaving the center above that gate; the user can still drag to
              // 52% when they want to read.
              content: <PluginDetailPane />,
              defaultSize: 34,
              minSize: 28,
              maxSize: 52,
            }
      }
    >
      <PluginSectionPane section={visibleSection} />
      <PluginExtensionSlot point="settings.plugins" className="border-t px-4 py-3 empty:hidden" />
    </FeaturePageShell>
  )
}
