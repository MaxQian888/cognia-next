/**
 * Model family: the bucket key a run estimate groups models by (ADR-0232).
 *
 * A concrete model id changes with every dated snapshot and minor version,
 * which would split one person's history into buckets too small to say
 * anything. A family keeps the vendor line and the tier words and drops the
 * version noise: `claude-sonnet-4-5-20250929` and `claude-3-5-sonnet-latest`
 * are both `claude-sonnet`, `gemini-2.5-pro` is `gemini-pro`.
 *
 * Deterministic and string-only on purpose: the estimate must not call a model
 * or a catalog to decide which bucket a run belongs to.
 */

import { baseModelId } from "@cognia/provider-core/providers/reasoning-suffix"

/** Cloud-marketplace prefixes (`us.anthropic.`, `amazon.`) that name a host, not a model. */
const HOST_PREFIX =
  /^(?:(?:us|eu|apac|global)\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|openai|google|deepseek)\./

/** Words that mark a release channel rather than a model line. */
const CHANNEL_WORDS = new Set(["latest", "preview", "exp", "experimental", "beta", "alpha"])

/**
 * A token is version noise when it starts with a digit (`4`, `2.5`, `4o`,
 * `20250929`) or is a `v`-number (`v3`, `v1.2`). Tokens that merely contain a
 * digit after a letter (`k2`, `o3`, `r1`) name a model line and are kept.
 */
function isVersionToken(token: string): boolean {
  return /^\d/.test(token) || /^v\d+(?:\.\d+)*$/.test(token)
}

/**
 * The family of a model id, or `null` when the id is empty or reduces to
 * nothing but version tokens.
 */
export function modelFamilyOf(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  let id = modelId.trim().toLowerCase()
  if (!id) return null
  // Provider-qualified ids (`openrouter/anthropic/claude-…`) name the model last.
  id = id.slice(id.lastIndexOf("/") + 1)
  // Bedrock revision suffix (`…-v1:0`) and Ollama tags (`llama3:8b`).
  id = id.split(":")[0]
  id = id.replace(HOST_PREFIX, "")
  id = baseModelId(id)
  const words = id
    .split(/[-_\s]+/)
    .filter((token) => token.length > 0 && !isVersionToken(token) && !CHANNEL_WORDS.has(token))
  return words.length > 0 ? words.join("-") : null
}
