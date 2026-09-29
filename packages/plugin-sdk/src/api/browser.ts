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

/**
 * The `browser_*` tool table (ADR-0201): names, agent-facing descriptions,
 * input schemas and approval flags. Pure data, shared by the bundled Browser
 * Tools plugin and the External Bridge MCP server so an external agent never
 * sees a tool shape the in-app agent does not have.
 */
export * from "./browser-tool-definitions"
