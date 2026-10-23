import { registerHooks } from "node:module"

// Mounted next to the pinned Logto packages; leave every other Got consumer alone.
const connector = new URL(
  "../packages/connectors/connector-http-email/lib/index.js",
  import.meta.url
)
const client = new URL(
  "../packages/connectors/connector-http-email/lib/cognia-client.mjs",
  import.meta.url
)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "got" && context.parentURL === connector.href) {
      return { url: client.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
