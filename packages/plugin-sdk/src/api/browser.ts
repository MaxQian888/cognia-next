/**
 * Plugin SDK — `browser` capability surface.
 *
 * The embedded browser is a host subsystem with three seams a plugin needs:
 *
 *  - `routeEngine()` picks the engine that will actually drive a page —
 *    the embedded webview, a remote CDP target, or a headless runner —
 *    according to the user's configuration. A plugin that talks to one of them
 *    directly works on one host profile and silently fails on the others.
 *  - `isBrowserDomainAuthorized()` is the consent gate. The user grants the
 *    browser per-domain; a tool that navigates without asking this question is
 *    a tool that visits sites the user never allowed. `primeBrowserDomainGrants()`
 *    loads the grant snapshot so the check is answerable synchronously.
 *  - `saveBrowserAnnotation()` persists what a run observed on a page, so the
 *    annotation shows up in the browser's own margin rather than only in the
 *    transcript.
 */

export { routeEngine } from "@/lib/browser/agent-engine"

export type {
  BrowserEngine,
  BrowserMutationResult,
  BrowserZoomResult,
  FindOptions,
  HandleDialogArgs,
  ScreenshotOptions,
  ScrollArgs,
  WaitForOptions,
} from "@/lib/browser/agent-engine"

export {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"

export type {
  BrowserActionResult,
  BrowserDialogState,
  BrowserSelection,
} from "@/lib/browser/protocol"

export { saveBrowserAnnotation } from "@/lib/db/browser-annotations"

export type {
  BrowserAnnotationIntent,
  BrowserAnnotationRow,
  BrowserAnnotationSeverity,
} from "@/lib/db/browser-annotations"
