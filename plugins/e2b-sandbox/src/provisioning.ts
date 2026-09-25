/**
 * Whether this build can provision an E2B sandbox at all.
 *
 * INTENTIONALLY DORMANT (CLAUDE.md rule 7 — documented here, labelled inert in
 * the Sandboxes panel and the `/sandbox` report, pinned by `provisioning.test.ts`
 * and `index.test.ts`).
 *
 * Provisioning needs the Node-only `e2b` SDK. It is not bundled into the
 * webview, and a bare-specifier `import()` cannot resolve there, so
 * `defaultSandboxFactory` in `workspace-backend.ts` always throws
 * `sdkUnavailableError()`. Registering the workspace backend or the microVM
 * exec adapter anyway made the host report both as available — Settings →
 * Sandbox offered the microVM tier, and choosing it could only fail at run
 * time. So while this is `false`, `activate()` registers neither; the code
 * behind them is kept, tested, and ready.
 *
 * Flip it to `true` only in the same change that ships a host-side bridge
 * which loads `e2b` in a Node process (the tracked follow-up), and update the
 * pinning tests with it.
 */
export const E2B_PROVISIONING_AVAILABLE = false

/** Read through a function so the gate is a single seam tests can drive. */
export function isProvisioningAvailable(): boolean {
  return E2B_PROVISIONING_AVAILABLE
}
