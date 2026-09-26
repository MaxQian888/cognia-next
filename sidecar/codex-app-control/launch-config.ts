/**
 * `open` arguments that relaunch the normal Codex App with its renderer's
 * DevTools protocol bound to loopback only. No environment overrides: the App
 * keeps its bundled runtime, which is what makes the relaunch reversible.
 */
export function buildCdpOnlyAppOpenArgs({
  appPath,
  cdpPort,
}: {
  appPath: string
  cdpPort: number
}): string[] {
  return [
    "--new",
    appPath,
    "--args",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
  ]
}
