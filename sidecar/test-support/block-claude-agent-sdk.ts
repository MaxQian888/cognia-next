// Preloaded with `node --import` to run a host as though the Claude Agent SDK
// were not installed (ADR-0217): resolving the SDK, or any of its subpaths,
// fails exactly as a missing package does.

import { register } from "node:module"

const hook = `
export async function resolve(specifier, context, next) {
  if (specifier === "@anthropic-ai/claude-agent-sdk" || specifier.startsWith("@anthropic-ai/claude-agent-sdk/")) {
    const error = new Error("Cannot find package '" + specifier + "' (blocked by the test)")
    error.code = "ERR_MODULE_NOT_FOUND"
    throw error
  }
  return next(specifier, context)
}
`

register(`data:text/javascript,${encodeURIComponent(hook)}`)
