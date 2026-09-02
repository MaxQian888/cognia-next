// Sanitize a saved chat template into a portable, shareable body, then PII-gate
// and optionally redact it before it leaves the device.
//
// A chat template is a message with `{{parameter}}` tokens plus the
// declarations that give those tokens labels, and optionally a launch spec: the
// session setup the template expects (model, permission mode, tools, MCP
// servers, skills, working directory).
//
// ## A link is a checkout
//
// The launch spec is DEMOTED with `demoteRepoLaunchSpec` before it is sent, the
// same treatment `.cognia/templates/*.md` gets when read out of a repository.
// The reasoning is identical and the risk is higher: a share link is a file
// from an author the recipient did not choose, so a template that arrives over
// one may propose a stricter conversation and may never propose a looser one.
// Everything that hands an agent capability (allowedTools, mcpServerIds,
// skillIds, agentModeId, workingDir) is dropped, and `permissionMode` is capped
// at `default`.
//
// Demotion happens on the WAY OUT rather than only on the way in, because the
// recipient of a link is not always this app: the payload is rendered by the
// public viewer too, and a viewer showing a `bypassPermissions` setup would be
// advertising it whether or not anything imported it.
//
// Credential-named fields are stripped with `isCredentialKey`, the same stem
// matcher the template platform validates payloads with. Nothing in this shape
// is hash-covered, so unlike `template-definition.ts` a redacted share here is
// still a valid share.

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { isCredentialKey } from "@/lib/templates/contracts"
import { demoteRepoLaunchSpec } from "@/lib/chat/template/repo-templates"
import type { ChatTemplateParam } from "@/lib/chat/template/template"
import type { ChatTemplateLaunchSpec } from "@/lib/chat/template/launch-spec"

/** The `chat-template` share payload body. */
export interface SharedChatTemplate {
  kind: "chat-template"
  name: string
  description?: string
  /** Message body, carrying `{{parameter}}` tokens. */
  body: string
  params: ChatTemplateParam[]
  /** Already demoted. See the header. */
  launchSpec?: ChatTemplateLaunchSpec
}

/** What `buildSharedChatTemplate` needs. A `ChatTemplateRow` satisfies it. */
export interface ShareableChatTemplate {
  name: string
  description?: string
  body: string
  params: readonly ChatTemplateParam[]
  launchSpec?: ChatTemplateLaunchSpec
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Drop declarations whose id names a credential.
 *
 * `lastParams` never travels at all, so the risk is narrower than it looks: a
 * `defaultValue` the author typed into an `apiKey` parameter. Dropping the
 * whole declaration rather than only its default is deliberate. The token stays
 * in the body, and on the receiving side `deriveParams` re-derives it as plain
 * required text, so the recipient is asked for the value instead of inheriting
 * one.
 */
function sanitizeParams(params: readonly ChatTemplateParam[]): ChatTemplateParam[] {
  return params
    .filter((param) => !isCredentialKey(param.id))
    .map((param) => ({
      id: param.id,
      label: param.label,
      ...(param.description ? { description: param.description } : {}),
      required: param.required,
      kind: param.kind,
      ...(param.defaultValue ? { defaultValue: param.defaultValue } : {}),
      ...(param.options?.length ? { options: [...param.options] } : {}),
      ...(param.resourceKind ? { resourceKind: param.resourceKind } : {}),
      ...(param.multiline ? { multiline: true } : {}),
    }))
}

/**
 * Belt and braces over the demoted launch spec.
 *
 * `demoteRepoLaunchSpec` names the fields it keeps, so no credential-shaped key
 * survives it today. Running the stem matcher afterwards means a field added to
 * `ChatTemplateLaunchSpec` later cannot reach a public link just because the
 * demoter was extended and this file was not.
 */
function stripCredentialFields(spec: ChatTemplateLaunchSpec): ChatTemplateLaunchSpec {
  return Object.fromEntries(
    Object.entries(spec).filter(([key]) => !isCredentialKey(key))
  ) as ChatTemplateLaunchSpec
}

/** Project a saved template into its shareable body. */
export function buildSharedChatTemplate(template: ShareableChatTemplate): SharedChatTemplate {
  const demoted = demoteRepoLaunchSpec(template.launchSpec)
  const launchSpec = demoted ? stripCredentialFields(demoted) : undefined
  return {
    kind: "chat-template",
    name: template.name,
    ...(trimOrUndefined(template.description)
      ? { description: trimOrUndefined(template.description)! }
      : {}),
    body: template.body,
    params: sanitizeParams(template.params),
    ...(launchSpec && Object.keys(launchSpec).length > 0 ? { launchSpec } : {}),
  }
}

/** Stable JSON serialization used as the share payload body. */
export function serializeSharedChatTemplate(shared: SharedChatTemplate): string {
  return JSON.stringify(shared)
}

/**
 * Parse a received payload body, re-demoting the launch spec.
 *
 * The demotion is applied AGAIN on the way in. The sender ran it, but the
 * sender is whoever minted the link, and a hand-crafted payload could carry any
 * setup at all. This is the same reason `parseRepoTemplate` demotes a file it
 * just read rather than trusting the writer.
 */
export function parseSharedChatTemplate(body: string): SharedChatTemplate | null {
  try {
    const parsed = JSON.parse(body) as Partial<SharedChatTemplate>
    if (
      parsed?.kind === "chat-template" &&
      typeof parsed.name === "string" &&
      typeof parsed.body === "string" &&
      Array.isArray(parsed.params)
    ) {
      const launchSpec = demoteRepoLaunchSpec(parsed.launchSpec)
      return {
        kind: "chat-template",
        name: parsed.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        body: parsed.body,
        params: sanitizeParams(parsed.params),
        ...(launchSpec ? { launchSpec: stripCredentialFields(launchSpec) } : {}),
      }
    }
  } catch {
    // Fall through to null. The viewer renders its own invalid state.
  }
  return null
}

/** True when the sanitized body still carries recognised PII. */
export function sharedChatTemplateHasPii(shared: SharedChatTemplate): boolean {
  return !hasNoLeakingPii(serializeSharedChatTemplate(shared))
}

/**
 * Redact PII out of the shareable body by scrubbing its serialized form and
 * re-parsing, the same trick `redactSharedDefinition` uses. Every field is a
 * string or an array of strings, and the placeholders are plain `<KIND_NNN>`
 * text, so the redacted JSON stays valid.
 */
export function redactSharedChatTemplate(shared: SharedChatTemplate): SharedChatTemplate {
  const redacted = redactText(serializeSharedChatTemplate(shared)).redacted
  return JSON.parse(redacted) as SharedChatTemplate
}
