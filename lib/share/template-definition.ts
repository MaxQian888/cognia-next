// Sanitize a PUBLISHED template release into a portable, shareable envelope,
// then PII-gate it before it leaves the device.
//
// A template definition is already the portable artifact of the template
// platform: `validateTemplateDefinition` refuses a payload carrying a
// credential key or a device-local path, and `verifyTemplateDefinitionHash`
// lets the receiver prove the body was not edited in transit. That last
// property is the constraint everything here works around.
//
// ## Why nothing hashed is touched
//
// `hashableDefinition` (`lib/templates/contracts.ts`) covers apiVersion, id,
// domain, version, metadata, payload, inputs, dependencies, capabilities and
// compatibility. Rewriting ANY of those, including a well-meant redaction,
// invalidates `contentHash`, and the receiver can then no longer tell a
// sanitized share from a forged one. So the credential strip runs as a CHECK:
// a definition whose hashed body still carries a credential key is REFUSED
// with a reason rather than quietly shipped in a form nothing can verify.
//
// The check is `isCredentialKey`, the same stem matcher `stripNonPortable`
// uses, and not `projectPortableTemplateValue` itself. The wider strip also
// removes structural keys such as `id`, which a workflow payload legitimately
// carries on every node, so running it here would refuse every workflow
// template on the grounds that its graph has node ids.
//
// What is not hashed is provenance, status, revision, baselineHash and the
// timestamps. Provenance is the sharer's local bookkeeping (which package on
// their disk, which plugin, which URL they got it from), so it is replaced
// rather than forwarded.

import { hasNoLeakingPii } from "@cognia/redact"
import {
  canonicalTemplateStringify,
  isCredentialKey,
  type TemplateDefinitionEnvelope,
  type TemplateJson,
} from "@/lib/templates/contracts"

/** The `template-definition` share payload body. */
export interface SharedTemplateDefinition {
  kind: "template-definition"
  definition: TemplateDefinitionEnvelope
}

/** Why a definition cannot be shared. */
export type SharedTemplateDefinitionRefusal = "unpublished" | "withdrawn" | "non-portable"

export type BuildSharedTemplateDefinitionResult =
  | { ok: true; shared: SharedTemplateDefinition }
  | { ok: false; reason: SharedTemplateDefinitionRefusal }

/**
 * Local provenance is dropped, not forwarded.
 *
 * `source: "user"` with `trust: "unsigned"` is the honest description of what a
 * recipient receives: a definition body that arrived over an anonymous link.
 * The receiver's own import rewrites it again to `source: "link"` with the URL
 * it came from, which is a claim the receiving device can actually stand behind.
 */
function neutralProvenance(): TemplateDefinitionEnvelope["provenance"] {
  return { source: "user", trust: "unsigned" }
}

/** The fields `verifyTemplateDefinitionHash` covers, as one JSON value. */
function hashedBody(definition: TemplateDefinitionEnvelope): TemplateJson {
  return {
    apiVersion: definition.apiVersion,
    id: definition.id,
    domain: definition.domain,
    version: definition.version,
    metadata: definition.metadata as unknown as TemplateJson,
    payload: definition.payload,
    inputs: definition.inputs as unknown as TemplateJson,
    dependencies: definition.dependencies as unknown as TemplateJson,
    capabilities: definition.capabilities,
    compatibility: definition.compatibility as unknown as TemplateJson,
  }
}

/** True when any object key anywhere under `value` names a credential. */
export function hasCredentialKey(value: TemplateJson): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialKey)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, nested]) => isCredentialKey(key) || hasCredentialKey(nested)
  )
}

/**
 * Project a definition into a shareable envelope, or say why it cannot be.
 *
 * Drafts are refused outright. A draft has `version: null`, which makes it
 * un-packageable on the receiving side (`definitionKey` throws on a definition
 * with no version) and un-citable on the sending side, since the next save
 * silently replaces it.
 */
export function buildSharedTemplateDefinition(
  definition: TemplateDefinitionEnvelope
): BuildSharedTemplateDefinitionResult {
  if (!definition.version || definition.status === "draft" || definition.status === "conflict") {
    return { ok: false, reason: "unpublished" }
  }
  if (definition.status !== "published") return { ok: false, reason: "withdrawn" }
  if (hasCredentialKey(hashedBody(definition))) return { ok: false, reason: "non-portable" }
  return {
    ok: true,
    shared: {
      kind: "template-definition",
      definition: { ...definition, provenance: neutralProvenance() },
    },
  }
}

/** Stable JSON serialization used as the share payload body. */
export function serializeSharedTemplateDefinition(shared: SharedTemplateDefinition): string {
  return JSON.stringify(shared)
}

/**
 * Parse a received payload body. Null for anything that is not a
 * `template-definition` envelope carrying a published release.
 *
 * Structural only. Whether the body still hashes to its `contentHash` is a
 * separate question the viewer asks `verifyTemplateDefinitionHash`, because the
 * answer is async and a failed hash is worth SAYING rather than collapsing into
 * "could not be loaded".
 */
export function parseSharedTemplateDefinition(body: string): SharedTemplateDefinition | null {
  try {
    const parsed = JSON.parse(body) as Partial<SharedTemplateDefinition>
    const definition = parsed?.definition
    if (
      parsed?.kind === "template-definition" &&
      definition &&
      typeof definition === "object" &&
      typeof definition.id === "string" &&
      typeof definition.domain === "string" &&
      typeof definition.contentHash === "string" &&
      typeof definition.version === "string" &&
      definition.metadata &&
      typeof definition.metadata.name === "string" &&
      Array.isArray(definition.inputs)
    ) {
      return { kind: "template-definition", definition }
    }
  } catch {
    // Fall through to null. The viewer renders its own invalid state.
  }
  return null
}

/**
 * True when the shareable envelope still carries recognised PII.
 *
 * There is deliberately no redaction twin of this function. Every field a
 * redactor would rewrite is inside the hashed body, so "remove and continue"
 * would hand the recipient a definition whose `contentHash` no longer matches
 * its content. The share button offers "cancel" or "share anyway" instead, and
 * the owner fixes the template when the answer is neither.
 */
export function sharedTemplateDefinitionHasPii(shared: SharedTemplateDefinition): boolean {
  return !hasNoLeakingPii(canonicalTemplateStringify(hashedBody(shared.definition)))
}
