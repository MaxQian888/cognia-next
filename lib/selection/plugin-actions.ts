import type { SelectionClassification } from "./classify-selection"
import type {
  PluginPermission,
  PluginQuickActionInvocation,
  PluginQuickActionResult,
  PluginSelectionOrigin,
  PluginSelectionReplaceCapability,
} from "@/types/plugin"
import {
  type QuickActionEntry,
  runQuickAction,
} from "@/lib/plugin/registries/quick-action-registry"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import { getPermissionGuard, type PermissionGuard } from "@/lib/plugin/security/permission-guard"

const MAX_RESULT_CHARS = 20_000
const MAX_STATUS_CHARS = 1_000
const MAX_VARIANTS = 8

export type SelectionQuickActionErrorCode =
  "notSelectionAction" | "ineligible" | "permissionDenied" | "invalidResult"

export class SelectionQuickActionError extends Error {
  constructor(
    public readonly code: SelectionQuickActionErrorCode,
    message: string
  ) {
    super(message)
    this.name = "SelectionQuickActionError"
  }
}

export interface PluginSelectionCandidate {
  id: string
  text: string
  sourceApp: string
  sourceTitle?: string
  sourceUrl?: string
  origin: PluginSelectionOrigin
  capturedAt: number
  truncated: boolean
  editable: boolean
  replaceCapability: PluginSelectionReplaceCapability
}

interface SelectionActionDependencies {
  guard?: PermissionGuard
  /**
   * Must accept the full `PluginPermission` union, not just `selection:read`:
   * `checkWithConsent` types the broker over every permission, and narrowing
   * the parameter here makes the callback unassignable under
   * `strictFunctionTypes`.
   */
  broker?: {
    request: (request: {
      pluginId: string
      permission: PluginPermission
      reason?: string
    }) => Promise<boolean>
  }
  reason?: string
}

function characterCount(value: string): number {
  return Array.from(value).length
}

function sanitizeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return undefined
  }
}

function invalidResult(message: string): never {
  throw new SelectionQuickActionError("invalidResult", message)
}

function normalizeResult(
  result: unknown,
  output: NonNullable<QuickActionEntry["selection"]>["output"]
): PluginQuickActionResult {
  if (result === undefined) {
    if (output === "none") return undefined
    if (output === "status") return { kind: "status" }
    return invalidResult(`Selection action declared ${output} output but returned no result`)
  }
  if (!result || typeof result !== "object" || !("kind" in result)) {
    return invalidResult("Selection action returned an unsupported result")
  }

  const value = result as Record<string, unknown>
  if (value.kind === "text") {
    if (output === "none" || output === "status") {
      return invalidResult(`Selection action declared ${output} output but returned text`)
    }
    if (typeof value.text !== "string" || characterCount(value.text) === 0) {
      return invalidResult("Selection action returned empty or non-text content")
    }
    if (characterCount(value.text) > MAX_RESULT_CHARS) {
      return invalidResult(`Selection action result exceeds ${MAX_RESULT_CHARS} characters`)
    }
    return { kind: "text", text: value.text }
  }

  if (value.kind === "variants") {
    if (output !== "preview") {
      return invalidResult("Selection action variants require preview output")
    }
    if (
      !Array.isArray(value.variants) ||
      value.variants.length === 0 ||
      value.variants.length > MAX_VARIANTS ||
      value.variants.some(
        (variant) =>
          typeof variant !== "string" ||
          characterCount(variant) === 0 ||
          characterCount(variant) > MAX_RESULT_CHARS
      )
    ) {
      return invalidResult("Selection action returned invalid variants")
    }
    return { kind: "variants", variants: [...value.variants] as string[] }
  }

  if (value.kind === "status") {
    if (output !== "none" && output !== "status") {
      return invalidResult(`Selection action declared ${output} output but returned status`)
    }
    if (
      value.message !== undefined &&
      (typeof value.message !== "string" || characterCount(value.message) > MAX_STATUS_CHARS)
    ) {
      return invalidResult("Selection action returned an invalid status message")
    }
    return value.message === undefined
      ? { kind: "status" }
      : { kind: "status", message: value.message as string }
  }

  return invalidResult("Selection action returned an unknown result kind")
}

export async function executePluginSelectionQuickAction(
  entry: QuickActionEntry,
  candidate: PluginSelectionCandidate,
  classification: SelectionClassification,
  dependencies: SelectionActionDependencies = {}
): Promise<PluginQuickActionResult> {
  const spec = entry.selection
  if (!entry.surfaces.includes("selection") || !spec) {
    throw new SelectionQuickActionError(
      "notSelectionAction",
      `${entry.fullId} is not registered for the selection surface`
    )
  }

  if (spec.origins?.length && !spec.origins.includes(candidate.origin)) {
    throw new SelectionQuickActionError("ineligible", "Selection origin is not eligible")
  }
  if (
    spec.contentTypes?.length &&
    !spec.contentTypes.some((type) => classification.types.includes(type))
  ) {
    throw new SelectionQuickActionError("ineligible", "Selection content type is not eligible")
  }
  if (spec.maxChars !== undefined && characterCount(candidate.text) > spec.maxChars) {
    throw new SelectionQuickActionError("ineligible", "Selection exceeds the action limit")
  }

  let text: string | undefined
  if (spec.input === "text") {
    const guard = dependencies.guard ?? getPermissionGuard()
    const broker = dependencies.broker ?? getPluginConsentBroker()
    const allowed = await guard.checkWithConsent(entry.pluginId, "selection:read", broker, {
      reason: dependencies.reason ?? `Allow ${entry.title} to read the current desktop selection`,
      context: `selection quick action:${entry.fullId}`,
    })
    if (!allowed) {
      throw new SelectionQuickActionError(
        "permissionDenied",
        `${entry.fullId} was not allowed to read the selection`
      )
    }
    text = candidate.text
  }

  const invocation: PluginQuickActionInvocation = {
    surface: "selection",
    selection: {
      candidateId: candidate.id,
      ...(text === undefined ? {} : { text }),
      sourceApp: candidate.sourceApp,
      sourceTitle: candidate.sourceTitle,
      sourceUrl: sanitizeSourceUrl(candidate.sourceUrl),
      origin: candidate.origin,
      capturedAt: candidate.capturedAt,
      truncated: candidate.truncated,
      contentTypes: [...classification.types],
      editable: candidate.editable,
      replaceCapability: candidate.replaceCapability,
    },
  }

  return normalizeResult(await runQuickAction(entry, invocation), spec.output)
}
