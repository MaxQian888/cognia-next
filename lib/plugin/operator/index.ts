/**
 * Operator action protocol barrel.
 *
 * Re-exports the unified Operator action vocabulary (`action-types`) and
 * the Anthropic Computer Use coordinate-scaling helpers (`coordinates`)
 * so that plugin authors and renderer-side dispatchers can pull both
 * from a single entry point.
 */

export * from "./action-types"
export * from "./coordinates"
