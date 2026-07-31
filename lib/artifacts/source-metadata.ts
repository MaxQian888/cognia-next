import { isRunnableArtifactType } from "./constants"
import type { Artifact, ArtifactMetadata, ArtifactType } from "@/types"

function normalizeArtifactContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim()
}

function hashFingerprint(input: string): string {
  let hash = 2166136261

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }

  return `afp_${(hash >>> 0).toString(16)}`
}

export function buildArtifactSourceFingerprint(params: {
  sessionId: string
  messageId: string
  type: ArtifactType
  content: string
  language?: string
}): string {
  const normalizedContent = normalizeArtifactContent(params.content)
  return hashFingerprint(
    [
      params.sessionId,
      params.messageId,
      params.type,
      params.language || "",
      normalizedContent,
    ].join("::")
  )
}

export function buildArtifactSourceMetadata(params: {
  sessionId: string
  messageId: string
  type: ArtifactType
  content: string
  language?: string
  sourceOrigin: "manual" | "auto" | "tool"
  userInitiated: boolean
  sourceRange?: { startIndex: number; endIndex: number }
  metadata?: ArtifactMetadata
}): ArtifactMetadata {
  const sourceFingerprint = buildArtifactSourceFingerprint({
    sessionId: params.sessionId,
    messageId: params.messageId,
    type: params.type,
    content: params.content,
    language: params.language,
  })

  return {
    ...params.metadata,
    // Stamped at creation so the "Runnable" badge has something to read. An
    // explicit value in `params.metadata` wins — the field is an override, and
    // a caller that set it deliberately outranks the type default.
    runnable: params.metadata?.runnable ?? isRunnableArtifactType(params.type),
    sourceOrigin: params.sourceOrigin,
    sourceFingerprint,
    lineageId: params.metadata?.lineageId || sourceFingerprint,
    sourceRange: params.sourceRange,
    userInitiated: params.userInitiated,
  }
}

export function buildDerivedArtifactMetadata(params: {
  artifactId: string
  sourceArtifact: Artifact
  sourceOrigin?: "manual" | "auto" | "tool"
  userInitiated?: boolean
  metadata?: ArtifactMetadata
}): ArtifactMetadata {
  const sourceMetadata = params.sourceArtifact.metadata || {}
  const sourceFingerprint =
    sourceMetadata.sourceFingerprint ||
    buildArtifactSourceFingerprint({
      sessionId: params.sourceArtifact.sessionId,
      messageId: params.sourceArtifact.messageId,
      type: params.sourceArtifact.type,
      content: params.sourceArtifact.content,
      language: params.sourceArtifact.language,
    })

  return {
    ...sourceMetadata,
    ...params.metadata,
    sourceOrigin: params.sourceOrigin ?? params.metadata?.sourceOrigin ?? "manual",
    sourceFingerprint: hashFingerprint([sourceFingerprint, params.artifactId].join("::")),
    lineageId: sourceMetadata.lineageId || sourceFingerprint,
    derivedFromArtifactId: params.sourceArtifact.id,
    derivedFromVersionId: params.sourceArtifact.version,
    userInitiated: params.userInitiated ?? params.metadata?.userInitiated ?? true,
  }
}

export function isDuplicateArtifactSource(params: {
  artifacts: Record<string, Artifact>
  sessionId: string
  messageId: string
  type: ArtifactType
  sourceFingerprint: string
}): boolean {
  return Object.values(params.artifacts).some(
    (artifact) =>
      artifact.sessionId === params.sessionId &&
      artifact.messageId === params.messageId &&
      artifact.type === params.type &&
      artifact.metadata?.sourceFingerprint === params.sourceFingerprint
  )
}
