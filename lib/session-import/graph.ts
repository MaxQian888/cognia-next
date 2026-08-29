import type { ImportedConversation } from "@/lib/data/importers/types"
import type { SessionFidelity } from "@cognia/agent-config-types/canonical-session"

import { conversationToCanonical, type SessionCodec } from "./codec-types"
import type { ImportedSessionGraph, ImportedSessionGraphNode } from "./types"

interface GraphBuildOptions {
  sourceRuntime: string
  sourceVersion?: string
  verifiedAt?: string
  importFidelity: SessionFidelity
  codec?: SessionCodec
}

interface FlatConversation {
  conversation: ImportedConversation
  parentSessionId?: string
}

function flatten(
  root: ImportedConversation,
  parentSessionId?: string,
  out: FlatConversation[] = []
): FlatConversation[] {
  if (parentSessionId && !root.session.parentSessionId)
    root.session.parentSessionId = parentSessionId
  out.push({ conversation: root, parentSessionId: root.session.parentSessionId ?? parentSessionId })
  for (const nested of root.nested ?? []) flatten(nested, root.session.id, out)
  return out
}

function graphRevision(nodes: readonly ImportedSessionGraphNode[]): string {
  let hash = 0x811c9dc5
  const feed = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  for (const node of nodes) {
    const { header } = node.session
    feed(header.canonicalSessionId)
    feed("\u001f")
    feed(header.sequenceDigest)
    feed("\u001f")
    feed(JSON.stringify(header.lineage ?? null))
    feed("\u001f")
    feed(JSON.stringify(header.lifecycle ?? null))
    feed("\u001e")
  }
  return `graph1-${hash.toString(16).padStart(8, "0")}`
}

/** Convert one legacy conversation tree into the loss-aware canonical graph. */
export function buildImportedSessionGraph(
  root: ImportedConversation,
  options: GraphBuildOptions
): ImportedSessionGraph {
  const flat = flatten(root)
  const canonicalIdBySessionId = new Map<string, string>()
  const bindingBySessionId = new Map(
    flat.map(({ conversation }) => [
      conversation.session.id,
      conversation.session.importRuntimeBinding,
    ])
  )
  const nodes = flat.map(({ conversation }) => {
    if (options.sourceVersion) conversation.session.importSourceVersion = options.sourceVersion
    const withoutNested: ImportedConversation = {
      session: conversation.session,
      messages: conversation.messages,
    }
    const conversion = options.codec
      ? options.codec.toCanonical(withoutNested)
      : conversationToCanonical(withoutNested, {
          sourceRuntime: options.sourceRuntime,
          importFidelity: options.importFidelity,
        })
    if (conversation.session.importCanonicalState) {
      Object.assign(conversion.session, conversation.session.importCanonicalState)
    }
    canonicalIdBySessionId.set(
      conversation.session.id,
      conversion.session.header.canonicalSessionId
    )
    return { conversation: withoutNested, ...conversion }
  })

  for (const node of nodes) {
    const parentSessionId = node.conversation.session.parentSessionId
    if (!parentSessionId) continue
    const current = node.session.header.lineage ?? node.conversation.session.importRelation
    node.session.header.lineage = {
      kind:
        current?.kind ?? (node.conversation.session.kind === "subagent" ? "subagent" : "branch"),
      ...current,
      parentCanonicalSessionId:
        current?.parentCanonicalSessionId ?? canonicalIdBySessionId.get(parentSessionId),
      parentNativeSessionId:
        current?.parentNativeSessionId ?? bindingBySessionId.get(parentSessionId)?.nativeSessionId,
    }
  }

  const sourceRevision = graphRevision(nodes)
  for (const node of nodes) {
    node.conversation.session.importSourceRevision = sourceRevision
    node.session.header.source = {
      ...(node.session.header.source ?? {}),
      ...(options.sourceVersion ? { version: options.sourceVersion } : {}),
      revision: sourceRevision,
      ...(options.verifiedAt ? { verifiedAt: options.verifiedAt } : {}),
    }
  }

  return {
    rootCanonicalSessionId: nodes[0]?.session.header.canonicalSessionId ?? "",
    sourceRevision,
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    nodes,
  }
}
