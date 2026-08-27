/**
 * Cognia Browser Companion contract — re-exported from the shared package.
 *
 * The definitions live in `@cognia/companion-client` rather than here because
 * the browser extension is a separately-built workspace that cannot resolve
 * the repo-root `@/` alias. Keeping the source in the package and the familiar
 * `@/types/browser-companion` path as a re-export means the two ends compile
 * the same contract instead of two copies of it.
 */
export type {
  BrowserCapturedText,
  BrowserCaptureMode,
  BrowserCompanionAppearanceV1,
  BrowserCompanionCapabilityV1,
  BrowserCompanionWorkspaceV1,
  BrowserContextLimits,
  BrowserContextSubmissionStatusV1,
  BrowserContextSubmissionSummaryPageV1,
  BrowserContextSubmissionSummaryV1,
  BrowserContextSubmitRequestV1,
  BrowserContextSubmitResponseV1,
  BrowserPageContextV1,
  BrowserReadableText,
  BrowserSubmissionStatus,
} from "@cognia/companion-client/browser-companion"

export {
  BROWSER_CAPTURE_MODES,
  BROWSER_CONTEXT_LIMITS,
  BROWSER_TERMINAL_STATUSES,
  isTerminalBrowserSubmissionStatus,
} from "@cognia/companion-client/browser-companion"
