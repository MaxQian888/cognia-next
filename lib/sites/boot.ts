/**
 * Host-neutral boot for Cognia Sites (ADR-0084).
 *
 * Two things the console could not do for itself.
 *
 * **Recovery.** `siteOperations` is a durable, resumable state machine, and the
 * ADR says operations "can resume after crashes or timeouts". In practice
 * `recoverInterruptedOperations` ran only from the console's own mount effect —
 * for the one selected Site, and only when the actor owned it. So an app that
 * crashed mid-upload left that operation wedged until somebody happened to open
 * `/sites` and click that Site. This sweeps every Site the actor owns, once, at
 * startup.
 *
 * **Notification.** A build takes minutes. Without a watcher, one that finished
 * while the user was elsewhere produced nothing at all.
 *
 * Lives in `lib/` rather than beside the React initializer so a headless host
 * could run the same body — `lib/issues/boot.ts` draws the same line. Nothing
 * here imports React or `next/*`.
 */

import { loggers } from "@cognia/logging"

import { listSiteProjects } from "@/lib/db/sites"
import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import { installSiteNotifications, type SiteNotifyTranslate } from "@/lib/sites/notify"

const log = loggers.shell

export interface BootSitesOptions {
  actorAccountId: string
  /** `useTranslations("sites")` on desktop; omitted falls back to English. */
  translate?: SiteNotifyTranslate
}

/**
 * Resume interrupted operations for every Site this actor owns.
 *
 * Owner-only because `recoverInterruptedOperations` asserts `manage`: a viewer
 * would throw once per Site and recover nothing. Sequential because
 * `claimNextSiteOperation` is a Dexie `rw` transaction over two tables — a
 * parallel sweep is pure contention.
 *
 * Two windows booting at once both sweep. That is safe rather than merely
 * tolerable: the claim is transactional, so they take disjoint operations, and
 * a claim that loses the race simply returns nothing.
 */
export async function recoverAllInterruptedSiteOperations(actorAccountId: string): Promise<number> {
  const sites = (await listSiteProjects()).filter(
    (site) => site.lifecycle !== "deleted" && site.authoringPolicy.ownerAccountId === actorAccountId
  )
  if (sites.length === 0) return 0

  // One service across the loop is fine here: recovery never loads the provider
  // token, so there is no stale-credential risk that would justify rebuilding it.
  const service = new CloudflareSitesService({ actorAccountId })
  let recovered = 0
  for (const site of sites) {
    try {
      recovered += await service.recoverInterruptedOperations(site.id)
    } catch (error) {
      // One unreachable Site must not stop the sweep for the rest.
      log.warn("sites: recovery failed for one Site", { siteId: site.id, error: String(error) })
    }
  }
  return recovered
}

/**
 * Returns a teardown for the watcher. Recovery has none — it is a one-shot.
 */
export async function bootSites(options: BootSitesOptions): Promise<() => void> {
  const dispose = installSiteNotifications({
    ...(options.translate ? { translate: options.translate } : {}),
    onError: (error) => log.warn("sites: notification watcher error", { error: String(error) }),
  })

  // After the watcher, so an operation this sweep terminates is itself reported
  // rather than resolving invisibly.
  try {
    const recovered = await recoverAllInterruptedSiteOperations(options.actorAccountId)
    if (recovered > 0) log.info("sites: recovered interrupted operations", { recovered })
  } catch (error) {
    log.warn("sites: recovery sweep failed", { error: String(error) })
  }

  return dispose
}
