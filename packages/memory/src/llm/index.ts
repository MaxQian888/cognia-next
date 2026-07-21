/**
 * Vendored LLM contract + JSON helper for the memory core. Barrel so moved
 * modules import both the `extractJson` value and the `LlmClient` type from a
 * single specifier (`../llm`) instead of the app's twin distill module.
 */
export { extractJson } from "./extract-json"
export type { LlmClient, LlmClientCallOptions, LlmUsageSnapshot } from "./types"
