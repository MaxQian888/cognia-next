import { routeEngine, type BrowserEngine } from "@/lib/browser/agent-engine"
import {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"
import { saveBrowserAnnotation, type BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import type { TrustTier } from "@/lib/browser/protocol"

export interface PluginBrowserRoute {
  engine: BrowserEngine
  tier: TrustTier
  untrusted: boolean
}

export interface PluginBrowserAPI {
  routeEngine(url: string, context?: { domainAuthorized?: boolean }): PluginBrowserRoute
  isDomainAuthorized(url: string): boolean
  primeDomainGrants(): Promise<string[]>
  saveAnnotation(annotation: BrowserAnnotationRow): Promise<void>
}

/** Host-owned browser router, consent snapshot, and annotation persistence. */
export function createBrowserAPI(): PluginBrowserAPI {
  return {
    routeEngine,
    isDomainAuthorized: isBrowserDomainAuthorized,
    primeDomainGrants: primeBrowserDomainGrants,
    saveAnnotation: saveBrowserAnnotation,
  }
}
