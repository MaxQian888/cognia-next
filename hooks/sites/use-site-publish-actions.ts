"use client"

/**
 * Every Site action the console can invoke, in one place.
 *
 * The old publish view carried these inline, which is why each one had to
 * re-read the hosting manifest, re-derive the source directory, and re-wire its
 * own busy flag. Here they share the action runner, the manifest controller,
 * and the preview session, so the console body stays a rendering concern.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { cancelSiteOperation, getSiteOperation } from "@/lib/db/sites"
import { uploadSiteVersion } from "@/lib/sites/publish-version"
import { buildAndSaveSiteVersion } from "@/lib/sites/build-version"
import { startSitePreview, stopSitePreview } from "@/lib/sites/preview"
import {
  ensureWranglerApproved,
  redetectWranglerBinary,
  type WranglerDetection,
} from "@/lib/sites/wrangler-detect"
import { latestEnvironmentRevision } from "@/lib/sites/console-model"
import type { SiteScaffoldFile } from "@/lib/sites/manifest-scaffold"
import type { SiteProjectRow, SiteVersionRow, SiteVisitorPolicy } from "@/types/sites"
import {
  deriveStepStates,
  type SiteLiveData,
  type SiteStepKey,
  type SiteStepState,
} from "./use-site-live-data"
import type { SiteHostingManifestController } from "./use-site-hosting-manifest"
import type { SitePreviewSessionController } from "./use-site-preview-session"
import type { SiteActions } from "./use-site-actions"

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
}

export interface SitePublishActions {
  stepStates: Record<SiteStepKey, SiteStepState>
  readyVersions: SiteVersionRow[]
  wrangler: WranglerDetection | null
  saveToken: (token: string) => void
  saveManifest: (text: string, extraFiles?: readonly SiteScaffoldFile[]) => void
  saveEnvironment: (input: {
    variables: Record<string, string>
    secrets: Record<string, string>
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
}: UseSitePublishActionsInput): SitePublishActions {
  const [wrangler, setWrangler] = useState<WranglerDetection | null>(null)

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

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

  // Reconcile any operation a crash interrupted. Owner only: the recovery path
  // claims leases, and a viewer holding no lease would just churn.
  //
  // The factory is read through a ref so recovery keys off the Site alone. A
  // caller that rebuilds the factory each render would otherwise re-run this
  // effect — and re-claim leases — on every render.
  const siteId = site?.id ?? null
  const isOwner = site?.authoringPolicy.ownerAccountId === actorAccountId
  const serviceRef = useRef(service)
  useEffect(() => {
    serviceRef.current = service
  }, [service])
  useEffect(() => {
    if (!siteId || !isOwner) return
    void serviceRef
      .current()
      .recoverInterruptedOperations(siteId)
      .catch(() => undefined)
  }, [siteId, isOwner])

  const connectDone = live.resources.some((row) => row.status === "active")
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
    (input: { variables: Record<string, string>; secrets: Record<string, string> }) => {
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
    void run("wrangler", async () => {
      setWrangler(await redetectWranglerBinary())
    })
  }, [run])

  const upload = useCallback(
    (version: SiteVersionRow) => {
      void run(`upload:${version.id}`, () =>
        uploadSiteVersion({
          siteId: requireSite().id,
          versionId: version.id,
          actorAccountId,
        })
      )
    },
    [run, requireSite, actorAccountId]
  )

  const deploy = useCallback(
    (version: SiteVersionRow) => {
      void run(`deploy:${version.id}`, () => service().deployVersion(requireSite().id, version.id))
    },
    [run, service, requireSite]
  )

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

  const takeDown = useCallback(() => {
    void run("takedown", () => service().takeDown(requireSite().id))
  }, [run, service, requireSite])

  const restore = useCallback(() => {
    void run("restore", () => service().restore(requireSite().id))
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
    refreshOperation,
    cancelOperation,
  }
}
