"use client"

/**
 * The Sites console.
 *
 * Replaces a dashboard that hid a complete deployment control plane behind a
 * five-step strip and a collapsible drawer — and that blanked itself entirely
 * outside the desktop shell, which is why the panel read as "no functionality
 * at all" in the browser. The console now renders everywhere over the local
 * Dexie tables; only the actions that genuinely need the native host are
 * disabled, each with its reason (see `useSiteActionGate`).
 *
 * Mobile keeps the desktop-only card: ADR-0084 defers the phone projection
 * until the sync table, delta reader, and tombstones exist, and nothing here
 * pretends otherwise.
 */
import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { CloudIcon, GlobeIcon, RefreshCwIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSiteActionGate, type SiteGate } from "@/hooks/sites/use-site-action-gate"
import { useSiteActions } from "@/hooks/sites/use-site-actions"
import { useSiteBuildInputs } from "@/hooks/sites/use-site-build-inputs"
import { useSiteHostingManifest } from "@/hooks/sites/use-site-hosting-manifest"
import { useSiteLiveData } from "@/hooks/sites/use-site-live-data"
import { useSitePreviewSession } from "@/hooks/sites/use-site-preview-session"
import { usePlatform } from "@/hooks/use-platform"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import {
  deleteSiteProjectMetadata,
  updateSiteAuthoringPolicy,
  updateSiteProviderConfig,
} from "@/lib/db/sites"
import { purgeRetentionReport } from "@/lib/sites/console-model"
import { useAccountStore } from "@/stores/account/account-store"
import {
  SITE_CONSOLE_TABS,
  isSiteConsoleTab,
  useSiteConsoleStore,
  type SiteConsoleTab,
} from "@/stores/sites/site-console-store"
import { useProjectStore } from "@/stores/project/project-store"
import { NewSiteDialog } from "./new-site-dialog"
import { SiteListRail } from "./site-list-rail"
import { SiteMobileOverview } from "./site-mobile-overview"
import { SiteOverviewHeader } from "./site-overview-header"
import { useSitePublishActions } from "@/hooks/sites/use-site-publish-actions"
import { SiteAccessTab } from "./tabs/site-access-tab"
import { SiteDomainsTab } from "./tabs/site-domains-tab"
import { SiteEnvironmentTab } from "./tabs/site-environment-tab"
import {
  SiteOperationsTab,
  type SiteObservabilityQuery,
  type SiteObservabilityResult,
} from "./tabs/site-operations-tab"
import { SitePublishTab } from "./tabs/site-publish-tab"
import { SiteResourcesTab } from "./tabs/site-resources-tab"
import { SiteVersionsTab } from "./tabs/site-versions-tab"

type Confirmation = "purge" | "delete-metadata" | null

export function SitesConsole() {
  const t = useTranslations("sites")
  // Two different questions, two different signals. `platform` answers "can
  // this shell drive wrangler / reach a deploy host", which stays a runtime
  // fact. `compact` answers "is there room for the console", which is width.
  const platform = usePlatform()
  const compact = useCompactLayout()
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const loadProjects = useProjectStore((state) => state.load)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const actorAccountId = unlockedAccountId ?? "local-user"

  const searchParams = useSearchParams()
  const pinnedId = useSiteConsoleStore((state) => state.selectedId)
  const tab = useSiteConsoleStore((state) => state.tab)
  const setPinnedId = useSiteConsoleStore((state) => state.select)
  const setTab = useSiteConsoleStore((state) => state.setTab)
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const [observabilityResult, setObservabilityResult] = useState<SiteObservabilityResult | null>(
    null
  )

  const live = useSiteLiveData(pinnedId)
  const site = live.sites.find((row) => row.id === live.selectedId) ?? null
  const { isBusy, run, service } = useSiteActions(actorAccountId)
  const gate = useSiteActionGate(site, actorAccountId)
  const manifest = useSiteHostingManifest(site)
  const preview = useSitePreviewSession(site?.id ?? null)
  // Keyed on the Site: the publish tab used to hold these as literals that did
  // not reset on selection change, so one Site's runtime and network
  // allowances were used for another's build.
  const buildInputs = useSiteBuildInputs(
    site?.id ?? null,
    live.versions,
    manifest.state.status === "ok" ? manifest.state.manifest : undefined
  )

  const publish = useSitePublishActions({
    site,
    actorAccountId,
    manifest,
    preview,
    live,
    run,
    service,
    loadProjects,
    // A shell that cannot shell out to wrangler must not probe for it.
    wranglerEnabled: platform === "tauri",
  })

  const retention = useMemo(() => purgeRetentionReport(live.resources), [live.resources])

  // A `?site=` deep link wins over whatever was last selected — it is what ⌘K
  // and Site notifications hand us, and landing on the previous selection would
  // silently ignore what the user asked for. Guarded on membership because the
  // live query resolves asynchronously; selecting before the rows land would
  // make the link look broken.
  const deepLinkId = searchParams.get("site")
  const deepLinkTab = searchParams.get("tab")
  useEffect(() => {
    if (!deepLinkId || deepLinkId === pinnedId) return
    if (live.sites.some((row) => row.id === deepLinkId)) setPinnedId(deepLinkId)
  }, [deepLinkId, live.sites, pinnedId, setPinnedId])

  useEffect(() => {
    // `select` resets the tab, so this has to run after it settles. An
    // unrecognized value is ignored rather than reset — a stale link should not
    // move someone off the tab they are on.
    if (!isSiteConsoleTab(deepLinkTab) || !deepLinkId || deepLinkId !== pinnedId) return
    setTab(deepLinkTab)
  }, [deepLinkTab, deepLinkId, pinnedId, setTab])

  // Mirror the selection back into the URL so the page can be linked to and
  // reloaded. `history.replaceState`, never `router.replace`: this is a static
  // export, and a route push re-evaluates the page.
  useEffect(() => {
    if (typeof window === "undefined" || !live.selectedId) return
    const url = new URL(window.location.href)
    if (url.searchParams.get("site") === live.selectedId && url.searchParams.get("tab") === tab) {
      return
    }
    url.searchParams.set("site", live.selectedId)
    url.searchParams.set("tab", tab)
    window.history.replaceState(window.history.state, "", url)
  }, [live.selectedId, tab])

  const deployGate = gate("provider", "deploy")
  // Upload and deploy are not the same permission-and-host question. Deploy is
  // a provider API call; upload additionally shells out to wrangler on this
  // machine. The console used to pass `deployGate` for both, so the two-prop
  // API on the versions tab was a lie and a missing wrangler surfaced only as a
  // failed click. Declared above the mobile branch — hooks cannot sit behind a
  // conditional return.
  const uploadGate = useMemo<SiteGate>(() => {
    if (!deployGate.allowed) return deployGate
    if (publish.wrangler?.ready) return deployGate
    return {
      allowed: false,
      reason: "requires-wrangler",
      title: t("host.reason.requires-wrangler"),
    }
  }, [deployGate, publish.wrangler, t])

  if (compact) {
    // ADR-0084 defers the mobile projection, and that stands — nothing here
    // reaches another host. But the same ADR says the console renders in every
    // shell over whichever local database that shell owns, and a bare
    // "desktop only" card ignored the second half: it could not say whether
    // this device knew about any Sites at all.
    return (
      <SiteMobileOverview
        sites={live.sites}
        activeDeployments={live.activeDeployments}
        loading={live.loading}
      />
    )
  }

  const providerGate = gate("provider", "manage")
  const buildGate = gate("build", "edit")
  const previewGate = gate("preview", "edit")
  const filesystemGate = gate("filesystem", "edit")
  const metadataGate = gate("metadata", "manage")

  const confirmDestructive = () => {
    const action = confirmation
    setConfirmation(null)
    if (!action || !site) return
    void run(
      action,
      async () => {
        if (action === "purge") await service().purge(site.id)
        else {
          await deleteSiteProjectMetadata(site.id)
          setPinnedId(null)
        }
      },
      // Purge and metadata deletion change what every other control acts on.
      { exclusive: true }
    )
  }

  const runObservability = (query: SiteObservabilityQuery) => {
    if (!site) return
    void run(
      query.kind,
      async () => {
        const value =
          query.kind === "logs"
            ? await service().logs(site.id, query.range.since, query.range.until, query.errorsOnly)
            : await service().analytics(
                site.id,
                new Date(query.range.since).toISOString(),
                new Date(query.range.until).toISOString()
              )
        // Tagged with the Site it came from: an untagged slot rendered site A's
        // numbers under site B's name after a selection change.
        setObservabilityResult({ kind: query.kind, siteId: site.id, value })
        return value
      },
      { successMessage: null }
    )
  }

  const showReconcileResult = (value: unknown) => {
    if (!site) return
    setObservabilityResult({ kind: "reconcile", siteId: site.id, value })
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as SiteConsoleTab)}
      className="contents"
      data-testid="sites-console"
    >
      <FeaturePageShell
        storageId="sites"
        header={
          <FeaturePageHeader
            variant="management"
            icon={<GlobeIcon />}
            title={t("title")}
            description={t("subtitle")}
            context={t("provider.title")}
            summary={t("summary.sites", { count: live.sites.length })}
            navigation={
              <TabsList variant="line" className="h-8 gap-1 bg-transparent p-0">
                {SITE_CONSOLE_TABS.map((key) => (
                  <TabsTrigger
                    key={key}
                    value={key}
                    disabled={!site}
                    className="h-8 px-2.5 text-xs"
                    data-testid={`sites-tab-${key}`}
                  >
                    {t(`tabs.${key}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            }
            secondaryActions={[
              {
                id: "reconcile",
                label: t("actions.reconcile"),
                icon: RefreshCwIcon,
                disabled: !site || isBusy("reconcile") || !providerGate.allowed,
                onSelect: () => publish.reconcile(showReconcileResult),
              },
            ]}
          />
        }
        leftPane={{
          label: t("rail.group"),
          defaultSize: 22,
          minSize: 16,
          maxSize: 34,
          mobileWidthClass: "w-[300px]",
          content: (
            <SiteListRail
              sites={live.sites}
              selectedId={live.selectedId}
              loading={live.loading}
              activeDeployments={live.activeDeployments}
              operationSignals={live.operationSignals}
              onSelect={setPinnedId}
              footer={
                <NewSiteDialog
                  projects={projects}
                  activeProjectId={activeProjectId}
                  actorAccountId={actorAccountId}
                  onCreated={setPinnedId}
                />
              }
            />
          ),
        }}
      >
        {platform !== "tauri" ? (
          <div
            role="status"
            data-testid="sites-host-banner"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs"
          >
            <CloudIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            <span className="font-medium">{t("desktopOnly.title")}</span>
            <span className="text-muted-foreground">{t("host.banner")}</span>
          </div>
        ) : null}

        {site ? (
          <div
            // `@container/site-pane`: everything multi-column inside a tab
            // sizes off THIS, never the viewport. The pane is a draggable
            // fraction of the window (the rail takes 16–34%), so a viewport
            // `md:` seats two columns in a 300px pane purely because the
            // monitor is wide.
            className="@container/site-pane flex min-h-0 flex-1 flex-col"
          >
            <SiteOverviewHeader
              site={site}
              versions={live.versions}
              deployments={live.deployments}
              operations={live.operations}
              resources={live.resources}
              actorAccountId={actorAccountId}
              gate={providerGate}
              metadataGate={metadataGate}
              isBusy={isBusy}
              onTakeDown={publish.takeDown}
              onRestore={publish.restore}
              onPurge={() => setConfirmation("purge")}
              onDeleteMetadata={() => setConfirmation("delete-metadata")}
            />

            <TabsContent value="publish" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-4xl p-4">
                <SitePublishTab
                  site={site}
                  stepStates={publish.stepStates}
                  operations={live.operations}
                  readyVersions={publish.readyVersions}
                  manifest={manifest}
                  wrangler={publish.wrangler}
                  previewUrl={preview.url}
                  isBusy={isBusy}
                  providerGate={providerGate}
                  buildGate={buildGate}
                  previewGate={previewGate}
                  deployGate={deployGate}
                  filesystemGate={filesystemGate}
                  onSaveToken={publish.saveToken}
                  onSaveManifest={publish.saveManifest}
                  onProvision={publish.provision}
                  onBuild={publish.build}
                  onStartPreview={publish.startPreview}
                  onStopPreview={publish.stopPreview}
                  onRedetectWrangler={publish.redetectWrangler}
                  buildInputs={buildInputs.inputs}
                  buildInputsSource={buildInputs.source}
                  setBuildInputs={buildInputs.setInputs}
                  onGoToVersions={() => setTab("versions")}
                  onGoToEnvironment={() => setTab("environment")}
                />
              </div>
            </TabsContent>

            {/* The versions list virtualizes, so it owns its own scroll
                container: this pane must not scroll on its behalf. */}
            <TabsContent value="versions" className="min-h-0 flex-1 overflow-hidden">
              <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col p-4">
                <SiteVersionsTab
                  versions={live.versions}
                  deployments={live.deployments}
                  resources={live.resources}
                  uploadGate={uploadGate}
                  deployGate={deployGate}
                  isBusy={isBusy}
                  onUpload={publish.upload}
                  onDeploy={publish.deploy}
                />
              </div>
            </TabsContent>

            <TabsContent value="environment" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-4xl p-4">
                <SiteEnvironmentTab
                  environments={live.environments}
                  gate={buildGate}
                  isBusy={isBusy}
                  onSave={publish.saveEnvironment}
                />
              </div>
            </TabsContent>

            <TabsContent value="domains" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-5xl p-4">
                <SiteDomainsTab
                  site={site}
                  resources={live.resources}
                  gate={providerGate}
                  isBusy={isBusy}
                  onAddDomain={publish.addDomain}
                  onRemoveDomain={publish.removeDomain}
                  onSaveProviderConfig={(patch) =>
                    void run("provider-config", () =>
                      updateSiteProviderConfig(site.id, actorAccountId, patch)
                    )
                  }
                  onApplyAccess={publish.applyAccess}
                />
              </div>
            </TabsContent>

            <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-4xl p-4">
                <SiteAccessTab
                  site={site}
                  actorAccountId={actorAccountId}
                  gate={metadataGate}
                  isBusy={isBusy}
                  onSave={(policy) =>
                    void run("authoring", () =>
                      updateSiteAuthoringPolicy(site.id, actorAccountId, policy)
                    )
                  }
                />
              </div>
            </TabsContent>

            <TabsContent value="resources" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-5xl p-4">
                <SiteResourcesTab
                  resources={live.resources}
                  versions={live.versions}
                  gate={providerGate}
                  isBusy={isBusy}
                  onReconcile={() => publish.reconcile(showReconcileResult)}
                  onReclaim={publish.reclaimArtifacts}
                />
              </div>
            </TabsContent>

            {/* Same as versions: the operation journal owns its scroll. */}
            <TabsContent value="operations" className="min-h-0 flex-1 overflow-hidden">
              <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col p-4">
                <SiteOperationsTab
                  site={site}
                  operations={live.operations}
                  resources={live.resources}
                  deployments={live.deployments}
                  gate={providerGate}
                  isBusy={isBusy}
                  result={observabilityResult}
                  onQuery={runObservability}
                  onClearResult={() => setObservabilityResult(null)}
                  onRefreshOperation={publish.refreshOperation}
                  onCancelOperation={publish.cancelOperation}
                />
              </div>
            </TabsContent>
          </div>
        ) : live.loading ? (
          // "Still reading" must not paint the same thing as "you have no
          // Sites", or every visit flashes an onboarding invitation before the
          // Dexie read resolves. The pane was previously blank here, which read
          // as a page that had failed.
          <div className="space-y-3 p-6" data-testid="sites-console-loading">
            <Skeleton className="h-16 w-full rounded-panel" />
            <Skeleton className="h-9 w-2/3 rounded-panel" />
            <Skeleton className="h-64 w-full rounded-panel" />
          </div>
        ) : (
          <Empty
            role="status"
            className="h-full gap-3 px-6 py-12"
            data-testid="sites-console-empty"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
                <GlobeIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle className="text-sm">{t("title")}</EmptyTitle>
              <EmptyDescription className="max-w-md text-xs">{t("empty")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </FeaturePageShell>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation === "purge"
                ? t("confirm.purge.title")
                : t("confirm.deleteMetadata.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "purge"
                ? t("confirm.purge.description")
                : t("confirm.deleteMetadata.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmation === "purge" ? (
            <p className="text-xs" data-testid="site-purge-scope">
              <span className="text-destructive">
                {t("resources.retention.purgeable", { count: retention.purgeable.length })}
              </span>{" "}
              <span className="text-muted-foreground">
                {t("resources.retention.retained", { count: retention.retained.length })}
              </span>
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDestructive}>
              {confirmation === "purge"
                ? t("actions.confirmPurge")
                : t("actions.confirmDeleteMetadata")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  )
}
