"use client"

/**
 * The guided publish flow, now six steps instead of five.
 *
 * The new step is the hosting manifest, slotted between connecting and the
 * environment because provisioning bindings, building, and previewing all read
 * `.cognia/hosting.json` — and until now nothing in the app could produce one,
 * so the three steps after it failed with a raw file-read error.
 *
 * Every control carries the host/authoring gate rather than throwing on click,
 * and the running operation's newest event streams into the owning step.
 */
import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlayIcon, RocketIcon, SquareIcon } from "lucide-react"

import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  SITE_STEP_ORDER,
  newestEventMessage,
  pickRunningOperation,
  stepOfOperation,
  type SiteStepKey,
  type SiteStepState,
} from "@/hooks/sites/use-site-live-data"
import { useSiteOperationEvents } from "@/hooks/sites/use-site-operation-events"
import type { SiteHostingManifestController } from "@/hooks/sites/use-site-hosting-manifest"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type { SiteScaffoldFile } from "@/lib/sites/manifest-scaffold"
import type { SiteOperationRow, SiteProjectRow, SiteVersionRow } from "@/types/sites"
import type { WranglerDetection } from "@/lib/sites/wrangler-detect"
import { SitePublishStep } from "../site-publish-step"
import { SiteManifestEditor } from "../site-manifest-editor"
import { splitValues } from "../split-values"

export interface SiteBuildInputs {
  runtime: string
  packageManager: string
  /** Hosts the dependency install may reach. */
  installNetworkHosts: string[]
  /**
   * Hosts the build command itself may reach. Empty means no network, which is
   * the fail-closed default ADR-0084 requires — a build that fetches at build
   * time has to say so explicitly.
   */
  buildNetworkHosts: string[]
}

export interface SitePublishTabProps {
  site: SiteProjectRow
  stepStates: Record<SiteStepKey, SiteStepState>
  operations: readonly SiteOperationRow[]
  readyVersions: readonly SiteVersionRow[]
  manifest: SiteHostingManifestController
  wrangler: WranglerDetection | null
  previewUrl: string | null
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  providerGate: SiteGate
  buildGate: SiteGate
  previewGate: SiteGate
  deployGate: SiteGate
  filesystemGate: SiteGate
  onSaveToken: (token: string) => void
  onSaveManifest: (text: string, extraFiles?: readonly SiteScaffoldFile[]) => void
  onProvision: () => void
  onBuild: (inputs: SiteBuildInputs) => void
  onStartPreview: () => void
  onStopPreview: () => void
  onRedetectWrangler: () => void
  onGoToVersions: () => void
  onGoToEnvironment: () => void
}

export function SitePublishTab({
  site,
  stepStates,
  operations,
  readyVersions,
  manifest,
  wrangler,
  previewUrl,
  isBusy,
  providerGate,
  buildGate,
  previewGate,
  deployGate,
  filesystemGate,
  onSaveToken,
  onSaveManifest,
  onProvision,
  onBuild,
  onStartPreview,
  onStopPreview,
  onRedetectWrangler,
  onGoToVersions,
  onGoToEnvironment,
}: SitePublishTabProps) {
  const t = useTranslations("sites")
  const [token, setToken] = useState("")
  const [runtime, setRuntime] = useState("node@24")
  const [packageManager, setPackageManager] = useState("pnpm@10")
  const [installHosts, setInstallHosts] = useState("registry.npmjs.org")
  const [buildHosts, setBuildHosts] = useState("")

  const runningOperation = pickRunningOperation(operations)
  const runningStep = stepOfOperation(runningOperation)
  // Scoped to the one operation in flight, so the publish flow's live sub-status
  // costs a single-operation query rather than every operation's events.
  const runningEvents = useSiteOperationEvents(runningOperation?.id ?? null)
  const runningMessage = newestEventMessage(runningEvents)
  const subStatusFor = (step: SiteStepKey): string | undefined =>
    runningOperation && runningStep === step ? runningMessage : undefined

  const index = (step: SiteStepKey) => SITE_STEP_ORDER.indexOf(step) + 1
  const manifestBlocked = !manifest.ready ? t("errors.manifestMissing") : undefined

  return (
    <div
      className="space-y-4 rounded-xl border bg-card p-4 shadow-sm"
      data-testid="site-publish-tab"
    >
      <SitePublishStep
        index={index("connect")}
        state={stepStates.connect}
        stateLabel={t(`stepState.${stepStates.connect}`)}
        title={t("steps.connect.title")}
        description={t("steps.connect.description")}
        subStatus={subStatusFor("connect")}
        hint={providerGate.title}
      >
        <div className="flex flex-wrap gap-2">
          <Input
            type="password"
            className="max-w-xs"
            value={token}
            aria-label={t("provider.token")}
            placeholder={t("provider.token")}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={isBusy("token") || !providerGate.allowed || !token}
            title={providerGate.title}
            onClick={() => {
              onSaveToken(token)
              setToken("")
            }}
            data-testid="site-save-token"
          >
            {t("actions.saveToken")}
          </Button>
        </div>
      </SitePublishStep>

      <Separator />

      <SitePublishStep
        index={index("manifest")}
        state={stepStates.manifest}
        stateLabel={t(`stepState.${stepStates.manifest}`)}
        title={t("steps.manifest.title")}
        description={t("steps.manifest.description")}
      >
        <SiteManifestEditor
          manifest={manifest}
          gate={filesystemGate}
          isBusy={isBusy}
          onSave={onSaveManifest}
        />
      </SitePublishStep>

      <Separator />

      <SitePublishStep
        index={index("environment")}
        state={stepStates.environment}
        stateLabel={t(`stepState.${stepStates.environment}`)}
        title={t("steps.environment.title")}
        description={t("steps.environment.description")}
        subStatus={subStatusFor("environment")}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onGoToEnvironment}
          data-testid="site-goto-environment"
        >
          {t("actions.editEnvironment")}
        </Button>
      </SitePublishStep>

      <Separator />

      <SitePublishStep
        index={index("build")}
        state={stepStates.build}
        stateLabel={t(`stepState.${stepStates.build}`)}
        title={t("steps.build.title")}
        description={t("steps.build.description")}
        subStatus={subStatusFor("build")}
        error={manifestBlocked}
        hint={buildGate.title}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Input
            value={runtime}
            aria-label={t("build.runtime")}
            placeholder={t("build.runtime")}
            onChange={(event) => setRuntime(event.target.value)}
          />
          <Input
            value={packageManager}
            aria-label={t("build.packageManager")}
            placeholder={t("build.packageManager")}
            onChange={(event) => setPackageManager(event.target.value)}
          />
          <Input
            value={installHosts}
            aria-label={t("build.networkHosts")}
            placeholder={t("build.networkHosts")}
            onChange={(event) => setInstallHosts(event.target.value)}
          />
        </div>
        <div className="mt-2">
          <Input
            value={buildHosts}
            aria-label={t("build.buildNetworkHosts")}
            placeholder={t("build.buildNetworkHosts")}
            onChange={(event) => setBuildHosts(event.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("build.buildNetworkHostsHint")}</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isBusy("provision") || !buildGate.allowed || !manifest.ready}
            title={buildGate.title}
            onClick={onProvision}
            data-testid="site-provision"
          >
            {t("actions.provision")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isBusy("build") || !buildGate.allowed || !manifest.ready}
            title={buildGate.title}
            onClick={() =>
              onBuild({
                runtime,
                packageManager,
                installNetworkHosts: splitValues(installHosts),
                buildNetworkHosts: splitValues(buildHosts),
              })
            }
            data-testid="site-build"
          >
            <RocketIcon aria-hidden className="size-4" />
            {t("actions.build")}
          </Button>
        </div>
      </SitePublishStep>

      <Separator />

      <SitePublishStep
        index={index("preview")}
        state={stepStates.preview}
        stateLabel={t(`stepState.${stepStates.preview}`)}
        title={t("steps.preview.title")}
        description={t("steps.preview.description")}
        subStatus={subStatusFor("preview")}
        error={manifestBlocked}
        hint={previewGate.title}
      >
        <div className="space-y-3">
          {previewUrl ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isBusy("stop-preview") || !previewGate.allowed}
              title={previewGate.title}
              onClick={onStopPreview}
              data-testid="site-stop-preview"
            >
              <SquareIcon aria-hidden className="size-4" />
              {t("actions.stopPreview")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isBusy("preview") || !previewGate.allowed || !manifest.ready}
              title={previewGate.title}
              onClick={onStartPreview}
              data-testid="site-start-preview"
            >
              <PlayIcon aria-hidden className="size-4" />
              {t("actions.preview")}
            </Button>
          )}
          {previewUrl ? (
            <div className="h-[50vh] min-h-[320px] overflow-hidden rounded-xl border">
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
        index={index("publish")}
        state={stepStates.publish}
        stateLabel={t(`stepState.${stepStates.publish}`)}
        title={t("steps.publish.title")}
        description={t("steps.publish.description")}
        subStatus={subStatusFor("publish")}
        hint={deployGate.title}
      >
        <div className="space-y-2">
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
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy("wrangler") || !deployGate.allowed}
                title={deployGate.title}
                onClick={onRedetectWrangler}
                data-testid="site-redetect-wrangler"
              >
                {t("actions.redetectWrangler")}
              </Button>
            </div>
          )}

          {readyVersions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("publish.noVersions")}</p>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onGoToVersions}
              data-testid="site-goto-versions"
            >
              {t("versions.title")} ({readyVersions.length})
            </Button>
          )}
        </div>
      </SitePublishStep>
    </div>
  )
}
