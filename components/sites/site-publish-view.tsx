"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlayIcon, RocketIcon, SquareIcon, Trash2Icon } from "lucide-react"

import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  deriveStepStates,
  latestEventMessage,
  pickRunningOperation,
  stepOfOperation,
  type SiteStepKey,
} from "@/hooks/sites/use-site-live-data"
import { deleteSiteProjectMetadata, getSiteArtifact } from "@/lib/db/sites"
import { createDir, readTextFile } from "@/lib/file/file-operations"
import { materializeSiteArtifact } from "@/lib/sites/artifact-package"
import { buildAndSaveSiteVersion } from "@/lib/sites/build-version"
import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import { parseSiteEnvironmentInput } from "@/lib/sites/environment-input"
import { parseSiteHostingManifest } from "@/lib/sites/manifest"
import { getSitePreviewSession, startSitePreview, stopSitePreview } from "@/lib/sites/preview"
import {
  ensureWranglerApproved,
  redetectWranglerBinary,
  type WranglerDetection,
} from "@/lib/sites/wrangler-detect"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"
import { SitePublishStep } from "./site-publish-step"
import { SiteAdvancedPanel } from "./site-advanced-panel"

function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export interface SitePublishViewProps {
  site: SiteProjectRow
  versions: SiteVersionRow[]
  deployments: SiteDeploymentRow[]
  environments: SiteEnvironmentRevisionRow[]
  resources: SiteResourceRow[]
  operations: SiteOperationRow[]
  events: SiteOperationEventRow[]
  actorAccountId: string
  onDeleted: () => void
}

/**
 * Progressive single-page publish flow. Steps derive their state from live
 * Dexie data (via {@link deriveStepStates}) and stream the running operation's
 * latest event as an inline sub-status, so a build/upload/deploy shows real
 * progress instead of a disabled button. Advanced provider config lives in a
 * collapsible drawer below.
 */
export function SitePublishView({
  site,
  versions,
  deployments,
  environments,
  resources,
  operations,
  events,
  actorAccountId,
  onDeleted,
}: SitePublishViewProps) {
  const t = useTranslations("sites")
  const service = useMemo(
    () => () => new CloudflareSitesService({ actorAccountId }),
    [actorAccountId]
  )

  const [busy, setBusy] = useState<string | null>(null)
  const [providerToken, setProviderToken] = useState("")
  const [tokenSaved, setTokenSaved] = useState(false)
  const [plainEnvironment, setPlainEnvironment] = useState("")
  const [secretEnvironment, setSecretEnvironment] = useState("")
  const [runtime, setRuntime] = useState("node@24")
  const [packageManager, setPackageManager] = useState("pnpm@10")
  const [installHosts, setInstallHosts] = useState("registry.npmjs.org")
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    () => getSitePreviewSession(site.id)?.url ?? null
  )
  const [wrangler, setWrangler] = useState<WranglerDetection | null>(null)
  const [destructiveConfirmation, setDestructiveConfirmation] = useState<
    "purge" | "delete-metadata" | null
  >(null)

  const latestEnvironment = environments[0]

  const act = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusy(key)
      try {
        await action()
        toast.success(t("feedback.success"))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(null)
      }
    },
    [t]
  )

  // Auto-detect and approve wrangler once, so upload never asks for a path.
  useEffect(() => {
    let cancelled = false
    ensureWranglerApproved()
      .then((detection) => {
        if (!cancelled) setWrangler(detection)
      })
      .catch(() => {
        if (!cancelled) setWrangler({ path: null, version: null, ready: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Reconcile any operation interrupted by a crash, owner only.
  useEffect(() => {
    if (site.authoringPolicy.ownerAccountId !== actorAccountId) return
    void service()
      .recoverInterruptedOperations(site.id)
      .catch(() => undefined)
  }, [site.id, site.authoringPolicy.ownerAccountId, actorAccountId, service])

  const redetect = async () => {
    setBusy("wrangler")
    try {
      setWrangler(await redetectWranglerBinary())
    } finally {
      setBusy(null)
    }
  }

  const connectDone = tokenSaved || resources.some((row) => row.status === "active")
  const stepStates = deriveStepStates({
    connectDone,
    environments,
    versions,
    deployments,
    previewActive: previewUrl !== null,
    operations,
  })
  const runningOperation = pickRunningOperation(operations)
  const runningStep = stepOfOperation(runningOperation)
  const subStatusFor = (step: SiteStepKey): string | undefined =>
    runningOperation && runningStep === step
      ? latestEventMessage(events, runningOperation.id)
      : undefined

  const uploadedVersionIds = new Set(
    resources
      .filter((row) => row.kind === "worker-version" && row.status === "active")
      .map((row) => row.displayName)
  )
  const readyVersions = versions.filter((version) => version.status === "ready")

  const saveToken = () =>
    act("token", async () => {
      await service().saveProviderToken(site.id, providerToken)
      setTokenSaved(true)
      setProviderToken("")
    })

  const saveEnvironment = () =>
    act("environment", async () => {
      await service().saveEnvironment({
        siteId: site.id,
        variables: parseSiteEnvironmentInput(plainEnvironment),
        secrets: parseSiteEnvironmentInput(secretEnvironment),
      })
      setSecretEnvironment("")
    })

  const provision = () =>
    act("provision", async () => {
      const path = await import("@tauri-apps/api/path")
      const sourceDir = site.sourceSubpath
        ? await path.join(site.sourceRoot, ...site.sourceSubpath.split("/"))
        : site.sourceRoot
      const manifest = parseSiteHostingManifest(
        await readTextFile(await path.join(sourceDir, ".cognia", "hosting.json"))
      )
      await service().provisionBindings(site.id, manifest.cloudflare.bindings)
    })

  const build = () =>
    act("build", async () => {
      if (!latestEnvironment) throw new Error(t("errors.environmentRequired"))
      await buildAndSaveSiteVersion({
        siteId: site.id,
        environmentRevisionId: latestEnvironment.id,
        runtime,
        packageManager,
        installNetworkHosts: splitValues(installHosts),
        actorAccountId,
      })
    })

  const preview = () =>
    act("preview", async () => {
      if (!latestEnvironment) throw new Error(t("errors.environmentRequired"))
      const session = await startSitePreview(site.id, latestEnvironment.id, { actorAccountId })
      setPreviewUrl(session.url)
    })

  const stopPreview = () =>
    act("stop-preview", async () => {
      await stopSitePreview(site.id)
      setPreviewUrl(null)
    })

  const upload = (version: SiteVersionRow) =>
    act(`upload:${version.id}`, async () => {
      const wranglerPath = wrangler?.path
      if (!wranglerPath) throw new Error(t("errors.wranglerRequired"))
      if (!version.artifactDigest) throw new Error(t("errors.artifactRequired"))
      const artifact = await getSiteArtifact(version.artifactDigest)
      if (!artifact) throw new Error(t("errors.artifactRequired"))
      const path = await import("@tauri-apps/api/path")
      const cacheRoot = await path.join(
        await path.appCacheDir(),
        "cognia-sites",
        site.id,
        version.id
      )
      await createDir(cacheRoot, { recursive: true })
      const materialized = await materializeSiteArtifact(artifact.bytes, cacheRoot)
      await service().uploadVersion(site.id, version.id, {
        wranglerBinaryPath: wranglerPath,
        stagingRoot: cacheRoot,
        configPath: await path.join(cacheRoot, "wrangler.json"),
        entryPath: materialized.entryPath,
        assetsPath: materialized.assetsPath,
      })
    })

  const deploy = (version: SiteVersionRow) =>
    act(
      `deploy:${version.id}`,
      async () => void (await service().deployVersion(site.id, version.id))
    )

  const destructive = (kind: "takedown" | "restore") =>
    act(kind, async () => {
      if (kind === "takedown") await service().takeDown(site.id)
      else await service().restore(site.id)
    })

  const confirmDestructiveAction = () => {
    const action = destructiveConfirmation
    setDestructiveConfirmation(null)
    if (!action) return
    void act(action, async () => {
      if (action === "purge") await service().purge(site.id)
      else {
        await deleteSiteProjectMetadata(site.id)
        onDeleted()
      }
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">{site.name}</h2>
          <p className="text-sm text-muted-foreground">
            {site.sourceRoot}/{site.sourceSubpath}
          </p>
        </div>
        <div className="flex gap-2">
          {site.lifecycle === "active" ? (
            <Button
              variant="outline"
              onClick={() => destructive("takedown")}
              disabled={busy !== null}
            >
              {t("actions.takeDown")}
            </Button>
          ) : site.lifecycle === "taken-down" ? (
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
          ) : site.lifecycle === "deleted" ? (
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

      <div className="space-y-4 rounded-xl border p-4">
        <SitePublishStep
          index={1}
          state={stepStates.connect}
          stateLabel={t(`stepState.${stepStates.connect}`)}
          title={t("steps.connect.title")}
          description={t("steps.connect.description")}
          subStatus={subStatusFor("connect")}
        >
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              className="max-w-xs"
              value={providerToken}
              onChange={(event) => setProviderToken(event.target.value)}
              placeholder={t("provider.token")}
            />
            <Button size="sm" onClick={saveToken} disabled={busy !== null || !providerToken}>
              {t("actions.saveToken")}
            </Button>
          </div>
        </SitePublishStep>

        <Separator />

        <SitePublishStep
          index={2}
          state={stepStates.environment}
          stateLabel={t(`stepState.${stepStates.environment}`)}
          title={t("steps.environment.title")}
          description={t("steps.environment.description")}
          subStatus={subStatusFor("environment")}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>{t("environment.variables")}</Label>
              <Textarea
                className="mt-2 min-h-24 font-mono text-xs"
                value={plainEnvironment}
                onChange={(event) => setPlainEnvironment(event.target.value)}
                placeholder={t("environment.variablesPlaceholder")}
              />
            </div>
            <div>
              <Label>{t("environment.secrets")}</Label>
              <Textarea
                className="mt-2 min-h-24 font-mono text-xs"
                value={secretEnvironment}
                onChange={(event) => setSecretEnvironment(event.target.value)}
                placeholder={t("environment.secretsPlaceholder")}
              />
            </div>
          </div>
          <Button size="sm" className="mt-3" onClick={saveEnvironment} disabled={busy !== null}>
            {t("actions.saveEnvironment")}
          </Button>
        </SitePublishStep>

        <Separator />

        <SitePublishStep
          index={3}
          state={stepStates.build}
          stateLabel={t(`stepState.${stepStates.build}`)}
          title={t("steps.build.title")}
          description={t("steps.build.description")}
          subStatus={subStatusFor("build")}
        >
          <div className="grid gap-3 md:grid-cols-3">
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
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={provision} disabled={busy !== null}>
              {t("actions.provision")}
            </Button>
            <Button size="sm" onClick={build} disabled={busy !== null}>
              <RocketIcon className="size-4" />
              {t("actions.build")}
            </Button>
          </div>
        </SitePublishStep>

        <Separator />

        <SitePublishStep
          index={4}
          state={stepStates.preview}
          stateLabel={t(`stepState.${stepStates.preview}`)}
          title={t("steps.preview.title")}
          description={t("steps.preview.description")}
          subStatus={subStatusFor("preview")}
        >
          <div className="space-y-3">
            {previewUrl ? (
              <Button size="sm" variant="outline" onClick={stopPreview} disabled={busy !== null}>
                <SquareIcon className="size-4" />
                {t("actions.stopPreview")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={preview} disabled={busy !== null}>
                <PlayIcon className="size-4" />
                {t("actions.preview")}
              </Button>
            )}
            {previewUrl ? (
              <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-xl border">
                <BrowserPreviewPane
                  key={previewUrl}
                  initialUrl={previewUrl}
                  ownerId={`sites:${site.id}`}
                />
              </div>
            ) : null}
          </div>
        </SitePublishStep>

        <Separator />

        <SitePublishStep
          index={5}
          state={stepStates.publish}
          stateLabel={t(`stepState.${stepStates.publish}`)}
          title={t("steps.publish.title")}
          description={t("steps.publish.description")}
          subStatus={subStatusFor("publish")}
        >
          <div className="space-y-3">
            {wrangler === null ? (
              <p className="text-xs text-muted-foreground">{t("wrangler.detecting")}</p>
            ) : wrangler.ready ? (
              <p className="text-xs text-muted-foreground">
                {t("wrangler.ready", { version: wrangler.version ?? "" })}
              </p>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-destructive">{t("wrangler.notFound")}</p>
                <p className="text-xs text-muted-foreground">{t("wrangler.installHint")}</p>
                <Button size="sm" variant="outline" onClick={redetect} disabled={busy !== null}>
                  {t("actions.redetectWrangler")}
                </Button>
              </div>
            )}
            {readyVersions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("publish.noVersions")}</p>
            ) : (
              readyVersions.map((version) => {
                const uploaded = uploadedVersionIds.has(version.id)
                const deployment = deployments.find((row) => row.versionId === version.id)
                return (
                  <div
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <div>
                      <div className="text-sm font-medium">
                        {t("versions.version", { sequence: version.sequence })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {version.source.commitSha}
                        {deployment ? (
                          <Badge className="ml-2" variant="secondary">
                            {t(`deploymentStatus.${deployment.status}`)}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    {uploaded ? (
                      <Button size="sm" onClick={() => deploy(version)} disabled={busy !== null}>
                        <RocketIcon className="size-4" />
                        {deployment ? t("actions.rollback") : t("actions.deploy")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => upload(version)}
                        disabled={busy !== null || !wrangler?.ready}
                      >
                        {t("actions.upload")}
                      </Button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </SitePublishStep>
      </div>

      <SiteAdvancedPanel
        key={site.id}
        site={site}
        resources={resources}
        operations={operations}
        events={events}
        service={service}
        actorAccountId={actorAccountId}
        busy={busy}
        act={act}
      />

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
