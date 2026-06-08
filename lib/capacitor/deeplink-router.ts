"use client"

import type { DeeplinkRoute } from "./deeplink"
import { loggers } from "@/lib/logging"

const log = loggers.shell

/**
 * Framework-agnostic deeplink dispatcher.
 *
 * The Capacitor `appUrlOpen` channel and the push-notifications tap path
 * both surface the same logical destinations — a session, a share-target
 * compose surface, a pair QR redemption, or an OAuth callback. Rather
 * than maintain inline switches in each subscriber, we route them all
 * through `dispatchRoute(route, navigators)` so the routing decisions
 * live in one place and have one test surface.
 *
 * The OAuth callback resolves via the awaitCallback registry inside
 * `lib/oauth/mobile-flow.ts` — there is no navigation to perform here.
 */

export interface DeeplinkNavigators {
  /** Navigate to a chat session (`/inbox/c/<id>`). */
  pushSession(sessionId: string): void
  /** Navigate to the share-target page with the captured text/url. */
  openShareTarget(opts: { text?: string; url?: string }): void
  /** Hand a pair QR payload to the `/pair` page for redemption. */
  redeemPair(payload: string): void
  /** Navigate to a workflow run detail (`/workflows/<wfId>/runs/<runId>`). */
  openWorkflowRun(opts: { workflowId: string; runId: string }): void
}

export function dispatchRoute(route: DeeplinkRoute, navigators: DeeplinkNavigators): void {
  switch (route.kind) {
    case "open_session":
      if (route.sessionId) navigators.pushSession(route.sessionId)
      return
    case "share_target":
      navigators.openShareTarget({ text: route.text, url: route.url })
      return
    case "pair_qr":
      navigators.redeemPair(route.payload)
      return
    case "open_workflow_run":
      if (route.workflowId && route.runId) {
        navigators.openWorkflowRun({ workflowId: route.workflowId, runId: route.runId })
      } else {
        log.warn("deeplink-router: workflow-run missing ids", { raw: route.raw })
      }
      return
    case "oauth_callback":
      // Resolved by lib/oauth/mobile-flow.ts:awaitCallback — no nav.
      return
    case "unknown":
      log.warn("deeplink-router: unknown route", { raw: route.raw })
      return
  }
}

/**
 * Build a `DeeplinkNavigators` adapter from a Next.js `useRouter()`
 * instance. Centralises the URL encoding so callers don't have to
 * remember which params take what shape.
 */
export interface NextRouterShape {
  push: (url: string) => void
  replace?: (url: string) => void
}

export function makeRouterNavigators(router: NextRouterShape): DeeplinkNavigators {
  return {
    pushSession: (sessionId) => {
      router.push(`/inbox/c?key=${encodeURIComponent(sessionId)}`)
    },
    openShareTarget: ({ text, url }) => {
      const search = new URLSearchParams()
      if (text) search.set("text", text)
      if (url) search.set("url", url)
      const qs = search.toString()
      router.push(qs ? `/share-target?${qs}` : "/share-target")
    },
    redeemPair: (payload) => {
      router.push(`/pair?payload=${encodeURIComponent(payload)}`)
    },
    openWorkflowRun: ({ workflowId, runId }) => {
      router.push(
        `/workflows/run?id=${encodeURIComponent(workflowId)}&runId=${encodeURIComponent(runId)}`
      )
    },
  }
}
