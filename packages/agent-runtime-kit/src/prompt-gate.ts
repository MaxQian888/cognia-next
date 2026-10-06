/**
 * Outbound-gate check for one prompt (ADR-0217).
 *
 * Protocols carry text inside base64 transport fields (file attachments,
 * resource blobs, SVG images) where a structural PII detector cannot see it.
 * This decodes the text-like ones and hands the message, its metadata and the
 * decoded text to the host's gate in one payload, so every integration checks
 * the same shapes before a send.
 */

import type { ExternalAgentMessage } from "@cognia/agent-contracts/external-agent"
import type { AgentOutboundGate } from "@cognia/agent-contracts/host"

function decodeBase64Utf8(input: string): string | undefined {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(input, "base64").toString("utf-8")
    }
    const binary = atob(input)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

function isTextLike(path: string, mimeType?: string): boolean {
  const mime = mimeType?.toLowerCase()
  if (
    mime?.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/yaml" ||
    mime === "image/svg+xml" ||
    mime?.endsWith("+json") ||
    mime?.endsWith("+xml")
  ) {
    return true
  }
  return /\.(?:c|cc|cpp|css|csv|h|hpp|html?|java|js|json|jsx|md|mdx|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml)$/i.test(
    path
  )
}

/**
 * True when `gate` lets this prompt leave the machine, including the text
 * hidden in its text-like base64 blocks. Binary payloads (PNG bytes) are not
 * decoded as text.
 */
export function promptInputPassesGate(
  message: ExternalAgentMessage,
  gate: AgentOutboundGate,
  metadata?: Record<string, unknown>
): boolean {
  const decodedTextContent = message.content.flatMap((content) => {
    let encoded: string | undefined
    let path = ""
    let mimeType: string | undefined

    if (content.type === "file" && content.encoding === "base64") {
      encoded = content.content
      path = content.path
      mimeType = content.mimeType
    } else if (content.type === "resource" && content.resource.blob !== undefined) {
      encoded = content.resource.blob
      path = content.resource.uri
      mimeType = content.resource.mimeType ?? undefined
    } else if (content.type === "image" && content.source.type === "base64") {
      encoded = content.source.data
      mimeType = content.source.mediaType
    }

    if (!encoded || !isTextLike(path, mimeType)) return []
    const decoded = decodeBase64Utf8(encoded)
    return decoded === undefined ? [] : [decoded]
  })

  return gate({ message, metadata, decodedTextContent })
}
