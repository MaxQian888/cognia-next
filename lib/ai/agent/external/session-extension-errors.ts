import type {
  ExternalAgentBranchReasonCode,
  ExternalAgentSessionExtensionMethod,
} from "@/types/agent/external-agent"

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.toLowerCase()
  }
  if (typeof error === "string") {
    return error.toLowerCase()
  }
  return ""
}

const UNSUPPORTED_SESSION_EXTENSION_ERROR_NAME = "ExternalAgentUnsupportedSessionExtensionError"
const UNSUPPORTED_SESSION_EXTENSION_REASON_CODE: ExternalAgentBranchReasonCode =
  "extension_unsupported"

function getUnsupportedSessionExtensionMessage(
  method: ExternalAgentSessionExtensionMethod
): string {
  if (method === "session/list") {
    return "Agent does not support session listing"
  }
  if (method === "session/fork") {
    return "Agent does not support session forking"
  }
  return "Agent does not support session resume"
}

export class ExternalAgentUnsupportedSessionExtensionError extends Error {
  readonly code: ExternalAgentBranchReasonCode = UNSUPPORTED_SESSION_EXTENSION_REASON_CODE
  readonly method: ExternalAgentSessionExtensionMethod

  constructor(
    method: ExternalAgentSessionExtensionMethod,
    message = getUnsupportedSessionExtensionMessage(method)
  ) {
    super(message)
    this.name = UNSUPPORTED_SESSION_EXTENSION_ERROR_NAME
    this.method = method
  }
}

export function createExternalAgentUnsupportedSessionExtensionError(
  method: ExternalAgentSessionExtensionMethod,
  message?: string
): ExternalAgentUnsupportedSessionExtensionError {
  return new ExternalAgentUnsupportedSessionExtensionError(method, message)
}

export function isExternalAgentUnsupportedSessionExtensionError(
  error: unknown,
  method?: ExternalAgentSessionExtensionMethod
): error is ExternalAgentUnsupportedSessionExtensionError {
  if (!(error instanceof ExternalAgentUnsupportedSessionExtensionError)) {
    return false
  }
  if (!method) {
    return true
  }
  return error.method === method
}

export function getExternalAgentUnsupportedSessionExtensionMethod(
  error: unknown
): ExternalAgentSessionExtensionMethod | null {
  if (isExternalAgentUnsupportedSessionExtensionError(error)) {
    return error.method
  }

  const message = normalizeErrorMessage(error)
  if (!message) {
    return null
  }

  if (message.includes("session/list") || message.includes("session listing")) {
    return "session/list"
  }
  if (message.includes("session/fork") || message.includes("session forking")) {
    return "session/fork"
  }
  if (message.includes("session/resume") || message.includes("session resume")) {
    return "session/resume"
  }

  return null
}

export function isExternalAgentMethodNotFoundError(error: unknown): boolean {
  const message = normalizeErrorMessage(error)
  if (!message) {
    return false
  }
  return message.includes("-32601") || message.includes("method not found")
}

export function isExternalAgentSessionExtensionUnsupportedForMethod(
  error: unknown,
  method: ExternalAgentSessionExtensionMethod
): boolean {
  if (isExternalAgentUnsupportedSessionExtensionError(error, method)) {
    return true
  }

  const unsupportedMethod = getExternalAgentUnsupportedSessionExtensionMethod(error)
  if (unsupportedMethod) {
    return unsupportedMethod === method
  }

  const message = normalizeErrorMessage(error)
  if (!message) {
    return false
  }

  const hasGenericUnsupportedSignal =
    message.includes("not support") ||
    message.includes("not supported") ||
    message.includes("unsupported")
  return message.includes("session") && hasGenericUnsupportedSignal
}

/**
 * Detects whether an error indicates ACP session extension methods are unsupported.
 * This is used to degrade session UI behavior silently when the upstream agent
 * does not implement unstable extension methods.
 */
export function isExternalAgentSessionExtensionUnsupportedError(error: unknown): boolean {
  if (isExternalAgentUnsupportedSessionExtensionError(error)) {
    return true
  }

  if (getExternalAgentUnsupportedSessionExtensionMethod(error)) {
    return true
  }

  const message = normalizeErrorMessage(error)
  if (!message) {
    return false
  }

  if (
    message.includes("does not support session listing") ||
    message.includes("does not support session resume") ||
    message.includes("does not support session forking")
  ) {
    return true
  }

  const hasSessionContext =
    message.includes("session") ||
    message.includes("session/list") ||
    message.includes("session/fork") ||
    message.includes("session/resume")
  const hasUnsupportedSignal =
    message.includes("not support") ||
    message.includes("not supported") ||
    message.includes("unsupported")
  const hasMethodNotFoundSignal = isExternalAgentMethodNotFoundError(message)

  if (hasSessionContext && hasUnsupportedSignal) {
    return true
  }

  return hasSessionContext && hasMethodNotFoundSignal
}
