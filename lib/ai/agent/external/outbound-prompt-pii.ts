import type { ExternalAgentMessage } from "@/types/agent/external-agent"

import { hasNoLeakingPiiDeep } from "@cognia/redact"

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
 * Inspect provider-visible prompt content before protocols hide text inside
 * base64 transport fields that the structural PII detector cannot decode.
 */
export function hasNoLeakingExternalAgentPromptInput(
  message: ExternalAgentMessage,
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
      mimeType = content.resource.mimeType
    } else if (content.type === "image" && content.source.type === "base64") {
      encoded = content.source.data
      mimeType = content.source.mediaType
    }

    if (!encoded || !isTextLike(path, mimeType)) return []
    const decoded = decodeBase64Utf8(encoded)
    return decoded === undefined ? [] : [decoded]
  })

  return hasNoLeakingPiiDeep({ message, metadata, decodedTextContent })
}
