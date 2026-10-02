/**
 * The API a proxy's providers register through: the proxy's own `vscode`.
 *
 * VS Code hands every extension its own API instance and checks ownership on
 * some registrations: a debug adapter factory, for one, is refused unless the
 * extension registering it contributes that debugger, and the debugger lives
 * in the proxy's package.json, not the broker's. A proxy bundled before it
 * passed its API gets the broker's, which serves every family but that one.
 */
export function proxyApi(candidate, fallback) {
  return candidate &&
    typeof candidate === "object" &&
    typeof candidate.languages === "object" &&
    typeof candidate.debug === "object"
    ? candidate
    : fallback
}
