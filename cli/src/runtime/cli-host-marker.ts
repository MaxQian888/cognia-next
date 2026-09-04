/**
 * Declare, on the global, that this process is the standalone CLI.
 *
 * `@/lib` cannot work this out by looking. A Node process has no `window`, and
 * `detectPlatform()` reads that as `web`, the browser baseline, whose
 * capability set is `["webview"]` with no `shell`. Everything in the shared
 * graph that asks "can a process start here" therefore answered *no* for a
 * process whose entire job is starting processes. The external-agent process
 * plane asks exactly that before a stdio agent may launch, so
 * `cognia-agent chat --backend <agent>` failed with "the stdio transport needs
 * a runtime that can start a process: the desktop app, or a paired Host" about
 * a child this process would have spawned itself
 * (`./external/node-backend.ts`).
 *
 * The headless brain has the same problem and solves it the same way
 * (`cli/src/serve/serve-command.ts` sets `__COGNIA_HEADLESS__`). This is that
 * marker's sibling, kept distinct because the two hosts are not
 * interchangeable: `isHeadlessHost()` also switches credential storage, backup
 * keys, OCR and the plugin loaders onto server-backed paths the CLI does not
 * use.
 *
 * Must run before the first `@/lib` import so no module can capture a verdict
 * from before it. Imports nothing, for the same reason.
 *
 * @see @/lib/platform/detect `isCliHost`
 * @see @/lib/ai/agent/external/process-plane
 */
export function markCliHostProcess(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): void {
  target.__COGNIA_CLI__ = true
}
