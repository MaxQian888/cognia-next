/**
 * Manual Jest mock for `tokenlens` (ESM-only npm package).
 *
 * The real `tokenlens` ships only an ESM bundle (`"type": "module"`,
 * `dist/index.js` with `export *` re-exports) which Jest's CJS runtime
 * cannot parse — even with `transformIgnorePatterns` whitelisted, SWC's
 * jest transformer does not consistently convert the cross-package
 * re-exports to CJS.
 *
 * Tests that touch components rendering the AI-elements `Context*`
 * primitives only need a deterministic `getUsage()` shape — they never
 * assert against the real model-cost catalog. We return zero usage and
 * undefined cost; callers handle the optional chaining.
 */

function getUsage(_input) {
  return {
    costUSD: undefined,
    inputTokens: _input?.usage?.input ?? 0,
    outputTokens: _input?.usage?.output ?? 0,
  }
}

function getModelMeta() {
  return undefined
}

function selectStaticModels() {
  return []
}

function sourceFromCatalog() {
  return undefined
}

function sourceFromModels() {
  return undefined
}

module.exports = {
  __esModule: true,
  getUsage,
  getModelMeta,
  selectStaticModels,
  sourceFromCatalog,
  sourceFromModels,
}
