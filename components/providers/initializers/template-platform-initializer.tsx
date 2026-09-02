"use client"

import { useEffect, useRef } from "react"
import { loggers } from "@cognia/logging"
import { useAccountStore } from "@/stores/account/account-store"
import {
  listTemplateMigrationJournal,
  putTemplateMigrationJournal,
} from "@/lib/db/template-platform"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { isUnifiedTemplatePlatformEnabled } from "@/lib/templates/feature-flags"
import { refreshCatalogOnlyTemplateAdapters } from "@/lib/templates/catalog-only-adapters"
import { refreshBuiltInTemplateOverlays } from "@/lib/templates/builtin-overlays"
import { createLegacyTemplateSources } from "@/lib/templates/legacy-sources"
import { migrateLegacyTemplates } from "@/lib/templates/migration"
import { createProductionTemplatePorts, getTemplateRuntime } from "@/lib/templates/runtime"
import { refreshTemplateOwners } from "@/lib/global-search/providers/library"

const log = loggers.shell

export async function bootTemplatePlatform(): Promise<void> {
  const runtime = getTemplateRuntime()
  const ports = createProductionTemplatePorts()
  const report = await migrateLegacyTemplates({
    sources: createLegacyTemplateSources({
      ports,
    }),
    service: runtime.service,
    repository: runtime.repository,
    journal: {
      list: listTemplateMigrationJournal,
      put: putTemplateMigrationJournal,
    },
  })
  // Spread rather than passed straight through: the logger takes a
  // `Record<string, unknown>`, and `TemplateMigrationReport` is an interface, so
  // it has no index signature of its own to satisfy that.
  log.info("template-platform: migration completed", { ...report })
  await refreshBuiltInTemplateOverlays({ catalog: runtime.catalog, ports })
  await refreshCatalogOnlyTemplateAdapters(runtime.catalog)
  // Global search ranks a template by which workspace owns it, and its
  // `belongs` predicate is synchronous by contract, so it reads a snapshot
  // rather than Dexie. Take it once the catalog is populated.
  await refreshTemplateOwners()

  /*
   * Give pre-isolation instances a workspace.
   *
   * `TemplateInstanceRecord.projectId` arrived after instances already existed,
   * and the Instances tab filters on it, so every row written before the column
   * simply stopped being listed — which reads as data loss, not as a filter.
   * `backfillInstanceWorkspaces` was written for exactly that and had no
   * caller anywhere in the app.
   *
   * Safe to run on every boot: it skips any instance that already has a
   * `projectId`, so a second run fills nothing. It runs last because the
   * migration above can mint instances of its own, and after them rather than
   * before is the only order that catches those too.
   *
   * `resolveScopeProjectId` is the same resolver `createTemplateRuntime` hands
   * the service, and it never returns null — it falls back to the Default
   * workspace — so a backfilled row is always attributable.
   */
  const filled = await runtime.service.backfillInstanceWorkspaces(await resolveScopeProjectId())
  if (filled > 0) log.info("template-platform: instance workspace backfill", { filled })
}

export function TemplatePlatformInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const startedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!isUnifiedTemplatePlatformEnabled() || !unlockedAccountId) return
    const key = `${unlockedAccountId}:${accountRevision}`
    if (startedFor.current === key) return
    startedFor.current = key
    void bootTemplatePlatform().catch((error) => {
      startedFor.current = null
      log.warn("template-platform: boot migration failed", { error })
    })
  }, [accountRevision, unlockedAccountId])

  return null
}

export default TemplatePlatformInitializer
