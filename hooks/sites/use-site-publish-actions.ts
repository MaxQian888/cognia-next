"use client"

/**
 * Every Site action the console can invoke, in one place.
 *
 * The old publish view carried these inline, which is why each one had to
 * re-read the hosting manifest, re-derive the source directory, and re-wire its
 * own busy flag. Here they share the action runner, the manifest controller,
 * and the preview session, so the console body stays a rendering concern.
 */
import { useCallback, useEffect, useMemo } from "react"

import { cancelSiteOperation, getSiteOperation } from "@/lib/db/sites"
import {
  SITE_ARTIFACT_GC_DEFAULTS,
  collectUnreferencedSiteArtifacts,
} from "@/lib/sites/artifact-gc"
import { uploadSiteVersion } from "@/lib/sites/publish-version"
import { buildAndSaveSiteVersion } from "@/lib/sites/build-version"
import { startSitePreview, stopSitePreview } from "@/lib/sites/preview"
import type { WranglerDetection } from "@/lib/sites/wrangler-detect"
import { latestEnvironmentRevision, siteTokenStanding } from "@/lib/sites/console-model"
import type { SiteScaffoldFile } from "@/lib/sites/manifest-scaffold"
import type {
  SiteProjectRow,
  SiteSecretEdit,
  SiteVersionRow,
  SiteVisitorPolicy,
} from "@/types/sites"
import {
  deriveStepStates,
  type SiteLiveData,
  type SiteStepKey,
  type SiteStepState,
} from "./use-site-live-data"
import type { SiteHostingManifestController } from "./use-site-hosting-manifest"
import type { SitePreviewSessionController } from "./use-site-preview-session"
import type { SiteActions } from "./use-site-actions"
import { useWranglerDetection } from "./use-wrangler-detection"

export interface SiteBuildInputs {
  runtime: string
  packageManager: string
  installNetworkHosts: string[]
  /** Empty means the build runs with no network, the fail-closed default. */
  buildNetworkHosts: string[]
}

export interface UseSitePublishActionsInput {
  site: SiteProjectRow | null
  actorAccountId: string
  manifest: SiteHostingManifestController
  preview: SitePreviewSessionController
  live: SiteLiveData
  run: SiteActions["run"]
  service: SiteActions["service"]
  loadProjects: () => Promise<unknown> | unknown
  /**
   * False on a host that cannot upload at all, so the wrangler probe never
   * runs there. Defaults to true.
   */
  wranglerEnabled?: boolean
}

export interface SitePublishActions {
  stepStates: Record<SiteStepKey, SiteStepState>
  readyVersions: SiteVersionRow[]
  wrangler: WranglerDetection | null
  saveToken: (token: string) => void
  saveManifest: (text: string, extraFiles?: readonly SiteScaffoldFile[]) => void
  saveEnvironment: (input: {
    variables: Record<string, string>
    secrets: readonly SiteSecretEdit[]
  }) => void
  provision: () => void
  build: (inputs: SiteBuildInputs) => void
  startPreview: () => void
  stopPreview: () => void
  redetectWrangler: () => void
  upload: (version: SiteVersionRow) => void
  deploy: (version: SiteVersionRow) => void
  addDomain: (hostname: string) => void
  removeDomain: (resourceId: string) => void
  applyAccess: (policy: SiteVisitorPolicy, hostname: string) => void
  takeDown: () => void
  restore: () => void
  reconcile: (onResult: (value: unknown) => void) => void
  /** Run artifact retention now instead of waiting for the daily sweep. */
  reclaimArtifacts: () => void
  refreshOperation: (operationId: string) => void
  cancelOperation: (operationId: string) => void
}

export function useSitePublishActions({
  site,
  actorAccountId,
  manifest,
  preview,
  live,
  run,
  service,
  loadProjects,
  wranglerEnabled = true,
}: UseSitePublishActionsInput): SitePublishActions {
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // Probe only; the ledger hash is deferred to the upload that needs it. The
  // old effect ran `ensureWranglerApproved` on every mount, SHA-256ing a
  // multi-megabyte binary with no Site selected and no intent to upload.
  const {
    detection: wrangler,
    ensureApproved,
    redetect,
  } = useWranglerDetection(wranglerEnabled && site !== null)

  // The console no longer sweeps for interrupted operations on mount: it did
  // so for the selected Site only, and only for its owner, so a crash mid-
  // upload stayed wedged until somebody opened /sites and clicked that exact
  // Site. `components/providers/initializers/sites-initializer.tsx` now sweeps
  // every owned Site once at startup (`lib/sites/boot.ts`).

  const connectDone =
    (site ? siteTokenStanding(site) === "verified" : false) ||
    live.resources.some((row) => row.status === "active")
  const stepStates = useMemo(
    () =>
      deriveStepStates({
        connectDone,
        manifestReady: manifest.ready,
        environments: live.environments,
        versions: live.versions,
        deployments: live.deployments,
        previewActive: preview.url !== null,
        operations: live.operations,
      }),
    [
      connectDone,
      manifest.ready,
      live.environments,
      live.versions,
      live.deployments,
      live.operations,
      preview.url,
    ]
  )

  const readyVersions = useMemo(
    () => live.versions.filter((version) => version.status === "ready"),
    [live.versions]
  )

  const requireSite = useCallback((): SiteProjectRow => {
    if (!site) throw new Error("no Site selected")
    return site
  }, [site])

  const saveToken = useCallback(
    (token: string) => {
      void run("token", () => service().saveProviderToken(requireSite().id, token))
    },
    [run, service, requireSite]
  )

  const saveManifest = useCallback(
    (text: string, extraFiles?: readonly SiteScaffoldFile[]) => {
      void run("manifest", () => manifest.save(text, extraFiles))
    },
    [run, manifest]
  )

  const saveEnvironment = useCallback(
    (input: { variables: Record<string, string>; secrets: readonly SiteSecretEdit[] }) => {
      void run("environment", () =>
        service().saveEnvironment({ siteId: requireSite().id, ...input })
      )
    },
    [run, service, requireSite]
  )

  const provision = useCallback(() => {
    void run("provision", async () => {
      const current = requireSite()
      if (manifest.state.status !== "ok") throw new Error("hosting manifest is not available")
      await service().provisionBindings(current.id, manifest.state.manifest.cloudflare.bindings)
    })
  }, [run, service, requireSite, manifest.state])

  const build = useCallback(
    (inputs: SiteBuildInputs) => {
      void run("build", async () => {
        const current = requireSite()
        const environment = latestEnvironmentRevision(live.environments)
        if (!environment) throw new Error("environment revision required")
        await buildAndSaveSiteVersion({
          siteId: current.id,
          environmentRevisionId: environment.id,
          runtime: inputs.runtime,
          packageManager: inputs.packageManager,
          installNetworkHosts: inputs.installNetworkHosts,
          buildNetworkHosts: inputs.buildNetworkHosts,
          actorAccountId,
        })
      })
    },
    [run, requireSite, live.environments, actorAccountId]
  )

  const startPreview = useCallback(() => {
    void run("preview", async () => {
      const current = requireSite()
      const environment = latestEnvironmentRevision(live.environments)
      if (!environment) throw new Error("environment revision required")
      const session = await startSitePreview(current.id, environment.id, { actorAccountId })
      preview.adopt(session.url)
    })
  }, [run, requireSite, live.environments, actorAccountId, preview])

  const stopPreview = useCallback(() => {
    void run("stop-preview", async () => {
      await stopSitePreview(requireSite().id)
      preview.adopt(null)
    })
  }, [run, requireSite, preview])

  const redetectWrangler = useCallback(() => {
    void run("wrangler", () => redetect())
  }, [run, redetect])

  const upload = useCallback(
    (version: SiteVersionRow) => {
      void run(`upload:${version.id}`, () =>
        uploadSiteVersion(
          { siteId: requireSite().id, versionId: version.id, actorAccountId },
          // The ledger hash happens here, once, rather than on every console
          // mount.
          { ensureWrangler: ensureApproved }
        )
      )
    },
    [run, requireSite, actorAccountId, ensureApproved]
  )

  const deploy = useCallback(
    (version: SiteVersionRow) => {
      void run(`deploy:${version.id}`, async () => {
        const deployment = await service().deployVersion(requireSite().id, version.id)
        // A deploy is what supersedes an older version, so it is the moment the
        // rollback window moves and something can genuinely be released. Never
        // fatal: the daily sweeper covers a failure here.
        await collectUnreferencedSiteArtifacts({
          now: Date.now(),
          ...SITE_ARTIFACT_GC_DEFAULTS,
        }).catch(() => undefined)
        return deployment
      })
    },
    [run, service, requireSite]
  )

  const reclaimArtifacts = useCallback(() => {
    void run("reclaim", async () => {
      requireSite()
      return collectUnreferencedSiteArtifacts({ now: Date.now(), ...SITE_ARTIFACT_GC_DEFAULTS })
    })
  }, [run, requireSite])

  const addDomain = useCallback(
    (hostname: string) => {
      void run("domain", () => service().addDomain(requireSite().id, hostname))
    },
    [run, service, requireSite]
  )

  const removeDomain = useCallback(
    (resourceId: string) => {
      void run(`remove:${resourceId}`, () => service().removeDomain(requireSite().id, resourceId))
    },
    [run, service, requireSite]
  )

  const applyAccess = useCallback(
    (policy: SiteVisitorPolicy, hostname: string) => {
      void run("access", () => service().reconcileVisitorAccess(requireSite().id, policy, hostname))
    },
    [run, service, requireSite]
  )

  // Takedown and restore change what every other control acts on — a domain
  // form or a deploy button aimed at a Site that is mid-takedown is a click
  // that will fail — so they hold the console rather than just their own key.
  const takeDown = useCallback(() => {
    void run("takedown", () => service().takeDown(requireSite().id), { exclusive: true })
  }, [run, service, requireSite])

  const restore = useCallback(() => {
    void run("restore", () => service().restore(requireSite().id), { exclusive: true })
  }, [run, service, requireSite])

  const reconcile = useCallback(
    (onResult: (value: unknown) => void) => {
      void run("reconcile", async () => {
        const value = await service().reconcile(requireSite().id)
        onResult(value)
        return value
      })
    },
    [run, service, requireSite]
  )

  const refreshOperation = useCallback(
    (operationId: string) => {
      void run(
        `operation:${operationId}`,
        async () => {
          await service().recoverInterruptedOperations(requireSite().id)
          return getSiteOperation(operationId)
        },
        { successMessage: null }
      )
    },
    [run, service, requireSite]
  )

  const cancelOperation = useCallback(
    (operationId: string) => {
      void run(`cancel:${operationId}`, () => cancelSiteOperation({ operationId }))
    },
    [run]
  )

  return {
    stepStates,
    readyVersions,
    wrangler,
    saveToken,
    saveManifest,
    saveEnvironment,
    provision,
    build,
    startPreview,
    stopPreview,
    redetectWrangler,
    upload,
    deploy,
    addDomain,
    removeDomain,
    applyAccess,
    takeDown,
    restore,
    reconcile,
    reclaimArtifacts,
    refreshOperation,
    cancelOperation,
  }
}
