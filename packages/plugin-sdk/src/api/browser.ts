/**
 * Type vocabulary for the governed `ctx.browser` capability.
 *
 * Runtime access deliberately stays on the activated context; this subpath
 * contains no host database or browser implementation and is therefore safe
 * to package. `ctx.browser.routeEngine()` selects the configured engine,
 * `isDomainAuthorized()` / `primeDomainGrants()` enforce domain consent, and
 * `saveAnnotation()` persists observations into the host browser workspace.
 */

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

export type {
  BrowserActionResult,
  BrowserDialogState,
  BrowserSelection,
} from "@/lib/browser/protocol"

export type {
  BrowserAnnotationIntent,
  BrowserAnnotationRow,
  BrowserAnnotationSeverity,
} from "@/lib/db/browser-annotations"
