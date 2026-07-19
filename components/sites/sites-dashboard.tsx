"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ActivityIcon,
  CloudIcon,
  Globe2Icon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RocketIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"

import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  createSiteProject,
  deleteSiteProjectMetadata,
  getSiteArtifact,
  listSiteDeployments,
  listSiteEnvironmentRevisions,
  listSiteOperationEvents,
  listSiteOperations,
  listSiteProjects,
  listSiteResources,
  listSiteVersions,
  updateSiteAuthoringPolicy,
} from "@/lib/db/sites"
import { readTextFile, createDir } from "@/lib/file/file-operations"
import { buildAndSaveSiteVersion } from "@/lib/sites/build-version"
import { materializeSiteArtifact } from "@/lib/sites/artifact-package"
import { approveSiteProviderTool } from "@/lib/sites/approved-tool"
import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import { parseSiteEnvironmentInput } from "@/lib/sites/environment-input"
import { parseSiteHostingManifest } from "@/lib/sites/manifest"
import { getSitePreviewSession, startSitePreview, stopSitePreview } from "@/lib/sites/preview"
import { isTauri } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import { useProjectStore } from "@/stores/project/project-store"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
  SiteVisitorPolicy,
} from "@/types/sites"

function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function SitesDashboard() {
  const t = useTranslations("sites")
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const loadProjects = useProjectStore((state) => state.load)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const actorAccountId = unlockedAccountId ?? "local-user"
  const [sites, setSites] = useState<SiteProjectRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [versions, setVersions] = useState<SiteVersionRow[]>([])
  const [deployments, setDeployments] = useState<SiteDeploymentRow[]>([])
  const [environments, setEnvironments] = useState<SiteEnvironmentRevisionRow[]>([])
  const [resources, setResources] = useState<SiteResourceRow[]>([])
  const [operations, setOperations] = useState<SiteOperationRow[]>([])
  const [operationEvents, setOperationEvents] = useState<SiteOperationEventRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [output, setOutput] = useState("")
  const [destructiveConfirmation, setDestructiveConfirmation] = useState<
    "purge" | "delete-metadata" | null
  >(null)

  const [projectId, setProjectId] = useState(activeProjectId ?? "")
  const [siteName, setSiteName] = useState("")
  const [sourceSubpath, setSourceSubpath] = useState("")
  const [accountId, setAccountId] = useState("")
  const [workerName, setWorkerName] = useState("")
  const [providerToken, setProviderToken] = useState("")
  const [plainEnvironment, setPlainEnvironment] = useState("")
  const [secretEnvironment, setSecretEnvironment] = useState("")
  const [runtime, setRuntime] = useState("node@24")
  const [packageManager, setPackageManager] = useState("pnpm@10")
  const [installHosts, setInstallHosts] = useState("registry.npmjs.org")
  const [wranglerPath, setWranglerPath] = useState("")
  const [accessMode, setAccessMode] = useState<SiteVisitorPolicy["mode"]>("private")
  const [accessValues, setAccessValues] = useState("")
  const [accessHostname, setAccessHostname] = useState("")
  const [domain, setDomain] = useState("")
  const [editorAccounts, setEditorAccounts] = useState("")
  const [deployerAccounts, setDeployerAccounts] = useState("")

  const selected = sites.find((site) => site.id === selectedId) ?? null
  const effectiveProjectId = projectId || activeProjectId || projects[0]?.id || ""
  const project = projects.find((candidate) => candidate.id === effectiveProjectId) ?? projects[0]
  const sourceRoot = project?.roots.find((root) => root.isPrimary)?.path ?? project?.roots[0]?.path
  const latestEnvironment = environments[0]
  const service = useMemo(
    () => () => new CloudflareSitesService({ actorAccountId }),
    [actorAccountId]
  )

  const refresh = useCallback(async () => {
    const nextSites = await listSiteProjects()
    setSites(nextSites)
    const nextSelected = selectedId ?? nextSites[0]?.id ?? null
    setSelectedId(nextSelected)
    const selectedSite = nextSites.find((site) => site.id === nextSelected)
    setEditorAccounts(selectedSite?.authoringPolicy.editorAccountIds.join("\n") ?? "")
    setDeployerAccounts(selectedSite?.authoringPolicy.deployerAccountIds.join("\n") ?? "")
    if (!nextSelected) {
      setVersions([])
      setDeployments([])
      setEnvironments([])
      setResources([])
      setOperations([])
      setOperationEvents([])
      setPreviewUrl(null)
      return
    }
    if (selectedSite?.authoringPolicy.ownerAccountId === actorAccountId) {
      await service().recoverInterruptedOperations(nextSelected)
    }
    const [nextVersions, nextDeployments, nextEnvironments, nextResources, nextOperations] =
      await Promise.all([
        listSiteVersions(nextSelected),
        listSiteDeployments(nextSelected),
        listSiteEnvironmentRevisions(nextSelected),
        listSiteResources(nextSelected),
        listSiteOperations(nextSelected),
      ])
    const nextEvents = (
      await Promise.all(nextOperations.map((operation) => listSiteOperationEvents(operation.id)))
    ).flat()
    setVersions(nextVersions)
    setDeployments(nextDeployments)
    setEnvironments(nextEnvironments)
    setResources(nextResources)
    setOperations(nextOperations)
    setOperationEvents(nextEvents)
    setPreviewUrl(getSitePreviewSession(nextSelected)?.url ?? null)
  }, [actorAccountId, selectedId, service])

  useEffect(() => {
    void loadProjects()
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [loadProjects, refresh])

  const act = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusy(key)
      try {
        await action()
        await refresh()
        toast.success(t("feedback.success"))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(null)
      }
    },
    [refresh, t]
  )

  const create = () =>
    act("create", async () => {
      if (!project || !sourceRoot) throw new Error(t("errors.projectRoot"))
      const site = await createSiteProject({
        id: `site_${crypto.randomUUID()}`,
        name: siteName,
        projectId: project.id,
        sourceRoot,
        sourceSubpath,
        executionTarget: { kind: "local" },
        provider: "cloudflare",
        providerConfig: { accountId, workerName },
        authoringPolicy: {
          ownerAccountId: actorAccountId,
          editorAccountIds: [],
          deployerAccountIds: [],
        },
        visitorPolicy: { mode: "private" },
      })
      setSelectedId(site.id)
      setSiteName("")
    })

  const saveEnvironment = () =>
    selected &&
    act("environment", async () => {
      await service().saveEnvironment({
        siteId: selected.id,
        variables: parseSiteEnvironmentInput(plainEnvironment),
        secrets: parseSiteEnvironmentInput(secretEnvironment),
      })
      setSecretEnvironment("")
    })

  const provision = () =>
    selected &&
    act("provision", async () => {
      const path = await import("@tauri-apps/api/path")
      const sourceDir = selected.sourceSubpath
        ? await path.join(selected.sourceRoot, ...selected.sourceSubpath.split("/"))
        : selected.sourceRoot
      const manifest = parseSiteHostingManifest(
        await readTextFile(await path.join(sourceDir, ".cognia", "hosting.json"))
      )
      await service().provisionBindings(selected.id, manifest.cloudflare.bindings)
    })

  const build = () =>
    selected &&
    act("build", async () => {
      if (!latestEnvironment) throw new Error(t("errors.environmentRequired"))
      await buildAndSaveSiteVersion({
        siteId: selected.id,
        environmentRevisionId: latestEnvironment.id,
        runtime,
        packageManager,
        installNetworkHosts: splitValues(installHosts),
        actorAccountId,
      })
    })

  const preview = () =>
    selected &&
    act("preview", async () => {
      if (!latestEnvironment) throw new Error(t("errors.environmentRequired"))
      const session = await startSitePreview(selected.id, latestEnvironment.id, { actorAccountId })
      setPreviewUrl(session.url)
    })

  const stopPreview = () =>
    selected &&
    act("stop-preview", async () => {
      await stopSitePreview(selected.id)
      setPreviewUrl(null)
    })

  const upload = (version: SiteVersionRow) =>
    selected &&
    act(`upload:${version.id}`, async () => {
      if (!wranglerPath.trim()) throw new Error(t("errors.wranglerRequired"))
      if (!version.artifactDigest) throw new Error(t("errors.artifactRequired"))
      const artifact = await getSiteArtifact(version.artifactDigest)
      if (!artifact) throw new Error(t("errors.artifactRequired"))
      const path = await import("@tauri-apps/api/path")
      const cacheRoot = await path.join(
        await path.appCacheDir(),
        "cognia-sites",
        selected.id,
        version.id
      )
      await createDir(cacheRoot, { recursive: true })
      const materialized = await materializeSiteArtifact(artifact.bytes, cacheRoot)
      await service().uploadVersion(selected.id, version.id, {
        wranglerBinaryPath: wranglerPath,
        stagingRoot: cacheRoot,
        configPath: await path.join(cacheRoot, "wrangler.json"),
        entryPath: materialized.entryPath,
        assetsPath: materialized.assetsPath,
      })
    })

  const deploy = (version: SiteVersionRow) =>
    selected &&
    act(
      `deploy:${version.id}`,
      async () => void (await service().deployVersion(selected.id, version.id))
    )

  const saveAccess = () =>
    selected &&
    act("access", async () => {
      let policy: SiteVisitorPolicy
      if (accessMode === "identities")
        policy = { mode: accessMode, emails: splitValues(accessValues) }
      else if (accessMode === "domains")
        policy = { mode: accessMode, domains: splitValues(accessValues) }
      else if (accessMode === "organization") {
        policy = { mode: accessMode, organizationId: accessValues.trim() }
      } else policy = { mode: accessMode }
      await service().reconcileVisitorAccess(selected.id, policy, accessHostname)
    })

  const addDomain = () =>
    selected && act("domain", async () => void (await service().addDomain(selected.id, domain)))

  const observe = (kind: "logs" | "analytics") =>
    selected &&
    act(kind, async () => {
      const now = Date.now()
      const result =
        kind === "logs"
          ? await service().logs(selected.id, now - 24 * 60 * 60 * 1000, now)
          : await service().analytics(
              selected.id,
              new Date(now - 24 * 60 * 60 * 1000).toISOString(),
              new Date(now).toISOString()
            )
      setOutput(JSON.stringify(result, null, 2))
    })

  const destructive = (kind: "takedown" | "restore") =>
    selected &&
    act(kind, async () => {
      if (kind === "takedown") await service().takeDown(selected.id)
      else await service().restore(selected.id)
    })

  const confirmDestructiveAction = () => {
    const action = destructiveConfirmation
    setDestructiveConfirmation(null)
    if (!selected || !action) return
    void act(action, async () => {
      if (action === "purge") await service().purge(selected.id)
      else {
        await deleteSiteProjectMetadata(selected.id)
        setSelectedId(null)
      }
    })
  }

  const uploadedVersionIds = new Set(
    resources
      .filter((row) => row.kind === "worker-version" && row.status === "active")
      .map((row) => row.displayName)
  )

  if (!isTauri()) {
    return (
      <Alert className="m-6">
        <CloudIcon />
        <AlertTitle>{t("desktopOnly.title")}</AlertTitle>
        <AlertDescription>{t("desktopOnly.description")}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between p-4">
          <div>
            <h1 className="font-semibold">{t("title")}</h1>
            <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => void refresh()}
            aria-label={t("actions.refresh")}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-3">
          <div className="space-y-2 pb-4">
            {sites.map((site) => (
              <button
                type="button"
                key={site.id}
                onClick={() => {
                  setSelectedId(site.id)
                  setEditorAccounts(site.authoringPolicy.editorAccountIds.join("\n"))
                  setDeployerAccounts(site.authoringPolicy.deployerAccountIds.join("\n"))
                }}
                className={`w-full rounded-lg border p-3 text-left ${selectedId === site.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{site.name}</span>
                  <Badge variant={site.lifecycle === "active" ? "default" : "secondary"}>
                    {t(`lifecycle.${site.lifecycle}`)}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {site.providerConfig.workerName}
                </p>
              </button>
            ))}
          </div>
        </ScrollArea>
        <Separator />
        <div className="space-y-2 p-3">
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={effectiveProjectId}
            onChange={(event) => setProjectId(event.target.value)}
            aria-label={t("create.project")}
          >
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <Input
            value={siteName}
            onChange={(event) => setSiteName(event.target.value)}
            placeholder={t("create.name")}
          />
          <Input
            value={sourceSubpath}
            onChange={(event) => setSourceSubpath(event.target.value)}
            placeholder={t("create.subpath")}
          />
          <Input
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            placeholder={t("create.accountId")}
          />
          <Input
            value={workerName}
            onChange={(event) => setWorkerName(event.target.value)}
            placeholder={t("create.workerName")}
          />
          <Button
            className="w-full"
            onClick={create}
            disabled={busy !== null || !siteName || !accountId || !workerName}
          >
            <PlusIcon className="size-4" /> {t("actions.create")}
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-6">
        {!selected ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold">{selected.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {selected.sourceRoot}/{selected.sourceSubpath}
                </p>
              </div>
              <div className="flex gap-2">
                {selected.lifecycle === "active" ? (
                  <Button
                    variant="outline"
                    onClick={() => destructive("takedown")}
                    disabled={busy !== null}
                  >
                    {t("actions.takeDown")}
                  </Button>
                ) : selected.lifecycle === "taken-down" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => destructive("restore")}
                      disabled={busy !== null}
                    >
                      {t("actions.restore")}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setDestructiveConfirmation("purge")}
                      disabled={busy !== null}
                    >
                      <Trash2Icon className="size-4" />
                      {t("actions.purge")}
                    </Button>
                  </>
                ) : selected.lifecycle === "deleted" ? (
                  <Button
                    variant="destructive"
                    onClick={() => setDestructiveConfirmation("delete-metadata")}
                    disabled={busy !== null}
                  >
                    <Trash2Icon className="size-4" />
                    {t("actions.deleteMetadata")}
                  </Button>
                ) : null}
              </div>
            </div>

            <Tabs defaultValue="build">
              <TabsList className="flex h-auto flex-wrap justify-start">
                <TabsTrigger value="build">
                  <RocketIcon />
                  {t("tabs.build")}
                </TabsTrigger>
                <TabsTrigger value="versions">
                  <HistoryIcon />
                  {t("tabs.versions")}
                </TabsTrigger>
                <TabsTrigger value="access">
                  <ShieldCheckIcon />
                  {t("tabs.access")}
                </TabsTrigger>
                <TabsTrigger value="domains">
                  <Globe2Icon />
                  {t("tabs.domains")}
                </TabsTrigger>
                <TabsTrigger value="observability">
                  <ActivityIcon />
                  {t("tabs.observability")}
                </TabsTrigger>
                <TabsTrigger value="provider">
                  <Settings2Icon />
                  {t("tabs.provider")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="build" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("environment.title")}</CardTitle>
                    <CardDescription>{t("environment.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 md:grid-cols-2">
                    <div>
                      <Label>{t("environment.variables")}</Label>
                      <Textarea
                        className="mt-2 min-h-32 font-mono text-xs"
                        value={plainEnvironment}
                        onChange={(event) => setPlainEnvironment(event.target.value)}
                        placeholder={t("environment.variablesPlaceholder")}
                      />
                    </div>
                    <div>
                      <Label>{t("environment.secrets")}</Label>
                      <Textarea
                        className="mt-2 min-h-32 font-mono text-xs"
                        value={secretEnvironment}
                        onChange={(event) => setSecretEnvironment(event.target.value)}
                        placeholder={t("environment.secretsPlaceholder")}
                      />
                    </div>
                    <Button onClick={saveEnvironment} disabled={busy !== null}>
                      {t("actions.saveEnvironment")}
                    </Button>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>{t("build.title")}</CardTitle>
                    <CardDescription>{t("build.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-3">
                    <Input
                      value={runtime}
                      onChange={(event) => setRuntime(event.target.value)}
                      placeholder={t("build.runtime")}
                    />
                    <Input
                      value={packageManager}
                      onChange={(event) => setPackageManager(event.target.value)}
                      placeholder={t("build.packageManager")}
                    />
                    <Input
                      value={installHosts}
                      onChange={(event) => setInstallHosts(event.target.value)}
                      placeholder={t("build.networkHosts")}
                    />
                    <Button variant="outline" onClick={provision} disabled={busy !== null}>
                      {t("actions.provision")}
                    </Button>
                    <Button onClick={build} disabled={busy !== null}>
                      <RocketIcon className="size-4" />
                      {t("actions.build")}
                    </Button>
                    {previewUrl ? (
                      <Button variant="outline" onClick={stopPreview} disabled={busy !== null}>
                        <SquareIcon className="size-4" />
                        {t("actions.stopPreview")}
                      </Button>
                    ) : (
                      <Button variant="outline" onClick={preview} disabled={busy !== null}>
                        <PlayIcon className="size-4" />
                        {t("actions.preview")}
                      </Button>
                    )}
                  </CardContent>
                </Card>
                {previewUrl ? (
                  <div className="h-[560px] overflow-hidden rounded-xl border">
                    <BrowserPreviewPane
                      key={previewUrl}
                      initialUrl={previewUrl}
                      ownerId={`sites:${selected.id}`}
                    />
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent value="versions" className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    value={wranglerPath}
                    onChange={(event) => setWranglerPath(event.target.value)}
                    placeholder={t("versions.wranglerPath")}
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      act("approve-tool", async () => {
                        await approveSiteProviderTool(wranglerPath)
                      })
                    }
                    disabled={busy !== null || !wranglerPath}
                  >
                    {t("actions.approveTool")}
                  </Button>
                </div>
                {versions.map((version) => {
                  const uploaded = uploadedVersionIds.has(version.id)
                  const deployment = deployments.find((row) => row.versionId === version.id)
                  return (
                    <Card key={version.id}>
                      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                        <div>
                          <div className="font-medium">
                            {t("versions.version", { sequence: version.sequence })}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {version.source.commitSha} · {t(`versionStatus.${version.status}`)}
                          </div>
                          {deployment ? (
                            <Badge className="mt-2" variant="secondary">
                              {t(`deploymentStatus.${deployment.status}`)}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex gap-2">
                          {version.status === "ready" && !uploaded ? (
                            <Button
                              variant="outline"
                              onClick={() => upload(version)}
                              disabled={busy !== null}
                            >
                              {t("actions.upload")}
                            </Button>
                          ) : null}
                          {version.status === "ready" && uploaded ? (
                            <Button onClick={() => deploy(version)} disabled={busy !== null}>
                              <RocketIcon className="size-4" />
                              {deployment ? t("actions.rollback") : t("actions.deploy")}
                            </Button>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
                <Card>
                  <CardHeader>
                    <CardTitle>{t("operations.title")}</CardTitle>
                    <CardDescription>{t("operations.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {operations.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("operations.empty")}</p>
                    ) : (
                      operations.map((operation) => (
                        <div key={operation.id} className="rounded-md border p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span>{t(`operationType.${operation.type}`)}</span>
                            <Badge variant="secondary">
                              {t(`operationStatus.${operation.status}`)}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("operations.eventCount", {
                              count: operationEvents.filter(
                                (event) => event.operationId === operation.id
                              ).length,
                            })}
                          </p>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="access">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("access.title")}</CardTitle>
                    <CardDescription>{t("access.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2">
                    <select
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={accessMode}
                      onChange={(event) =>
                        setAccessMode(event.target.value as SiteVisitorPolicy["mode"])
                      }
                      aria-label={t("access.mode")}
                    >
                      {["private", "identities", "domains", "organization", "public"].map(
                        (mode) => (
                          <option key={mode} value={mode}>
                            {t(`access.modes.${mode}`)}
                          </option>
                        )
                      )}
                    </select>
                    <Input
                      value={accessHostname}
                      onChange={(event) => setAccessHostname(event.target.value)}
                      placeholder={t("access.hostname")}
                    />
                    <Textarea
                      value={accessValues}
                      onChange={(event) => setAccessValues(event.target.value)}
                      placeholder={t("access.values")}
                    />
                    <Button onClick={saveAccess} disabled={busy !== null}>
                      {t("actions.saveAccess")}
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="domains">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("domains.title")}</CardTitle>
                    <CardDescription>{t("domains.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Input
                        value={domain}
                        onChange={(event) => setDomain(event.target.value)}
                        placeholder={t("domains.hostname")}
                      />
                      <Button onClick={addDomain} disabled={busy !== null}>
                        {t("actions.addDomain")}
                      </Button>
                    </div>
                    {resources
                      .filter((row) => row.kind === "custom-domain" && row.status === "active")
                      .map((row) => (
                        <div
                          key={row.id}
                          className="flex items-center justify-between rounded-md border p-3 text-sm"
                        >
                          <span>{row.displayName}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              act(`remove:${row.id}`, async () =>
                                service().removeDomain(selected.id, row.id)
                              )
                            }
                          >
                            {t("actions.remove")}
                          </Button>
                        </div>
                      ))}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="observability">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("observability.title")}</CardTitle>
                    <CardDescription>{t("observability.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => observe("logs")}
                        disabled={busy !== null}
                      >
                        {t("actions.loadLogs")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => observe("analytics")}
                        disabled={busy !== null}
                      >
                        {t("actions.loadAnalytics")}
                      </Button>
                    </div>
                    <pre className="max-h-[500px] overflow-auto rounded-lg bg-muted p-4 text-xs">
                      {output || t("observability.empty")}
                    </pre>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="provider">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("provider.title")}</CardTitle>
                    <CardDescription>{t("provider.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Input
                      type="password"
                      value={providerToken}
                      onChange={(event) => setProviderToken(event.target.value)}
                      placeholder={t("provider.token")}
                    />
                    <Button
                      onClick={() =>
                        act("token", async () => {
                          await service().saveProviderToken(selected.id, providerToken)
                          setProviderToken("")
                        })
                      }
                      disabled={busy !== null}
                    >
                      {t("actions.saveToken")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        act("reconcile", async () => {
                          setOutput(JSON.stringify(await service().reconcile(selected.id), null, 2))
                        })
                      }
                      disabled={busy !== null}
                    >
                      {t("actions.reconcile")}
                    </Button>
                    <div className="grid gap-2 text-sm md:grid-cols-2">
                      <div>
                        {t("provider.account")}: {selected.providerConfig.accountId}
                      </div>
                      <div>
                        {t("provider.worker")}: {selected.providerConfig.workerName}
                      </div>
                    </div>
                    <Separator />
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <Label>{t("authoring.editors")}</Label>
                        <Textarea
                          className="mt-2"
                          value={editorAccounts}
                          onChange={(event) => setEditorAccounts(event.target.value)}
                          placeholder={t("authoring.accountsPlaceholder")}
                        />
                      </div>
                      <div>
                        <Label>{t("authoring.deployers")}</Label>
                        <Textarea
                          className="mt-2"
                          value={deployerAccounts}
                          onChange={(event) => setDeployerAccounts(event.target.value)}
                          placeholder={t("authoring.accountsPlaceholder")}
                        />
                      </div>
                      <Button
                        variant="outline"
                        onClick={() =>
                          act("authoring", async () => {
                            await updateSiteAuthoringPolicy(selected.id, actorAccountId, {
                              ownerAccountId: selected.authoringPolicy.ownerAccountId,
                              editorAccountIds: splitValues(editorAccounts),
                              deployerAccountIds: splitValues(deployerAccounts),
                            })
                          })
                        }
                        disabled={busy !== null}
                      >
                        {t("actions.saveAuthoring")}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>
      <AlertDialog
        open={destructiveConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setDestructiveConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {destructiveConfirmation === "purge"
                ? t("confirm.purge.title")
                : t("confirm.deleteMetadata.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {destructiveConfirmation === "purge"
                ? t("confirm.purge.description")
                : t("confirm.deleteMetadata.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDestructiveAction}>
              {destructiveConfirmation === "purge"
                ? t("actions.confirmPurge")
                : t("actions.confirmDeleteMetadata")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
