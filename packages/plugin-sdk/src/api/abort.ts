/**
 * Plugin SDK — cancellation helpers.
 *
 * Published face for `../runtime/abort`. Host code and plugins both need to
 * fold a caller's `AbortSignal` together with their own; without this subpath
 * the only way in was a deep `packages/plugin-sdk/src/runtime/…` source
 * import, which no consumer resolving the package normally can follow.
 */

export { combineAbortSignals } from "../runtime/abort"
