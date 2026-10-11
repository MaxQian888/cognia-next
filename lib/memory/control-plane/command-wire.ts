/**
 * The wire form of a `/memory` console command.
 *
 * A paired device (a phone, a browser on a headless host, a desktop driving a
 * remote host) runs the console against the host's store, so the same
 * {@link ManageMemoryCommand} the local console hands to `manageMemory` travels
 * over the companion RPC `memory_mutate`. This module is the host's gate on
 * that payload: it accepts exactly the shapes `manageMemory` takes, with every
 * field type-checked, and refuses anything else as `null` rather than letting a
 * half-valid object reach the store.
 *
 * Kept free of Dexie and settings imports so both ends (the queueing client and
 * the dispatching host) can share it.
 */

import { isMemoryType, type MemoryScope } from "@/types/memory/memory"
import {
  RETRIEVAL_FEEDBACK_VERDICTS,
  type RetrievalFeedbackVerdict,
} from "@cognia/memory/lifecycle/retrieval-feedback"
import type { ListMemoriesQuery, MemoryNamespaceTarget } from "@/lib/db/memories"
import type { ManageMemoryCommand } from "./manage"

const SCOPES: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]
const MAX_TEXT = 20_000
const MAX_TAGS = 64
const MAX_ID = 512

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID ? value : null
}

function optionalId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return id(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT ? value : null
}

function tags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TAGS) return null
  return value.every((tag) => typeof tag === "string" && tag.length <= MAX_ID)
    ? (value as string[])
    : null
}

function importance(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function scope(value: unknown): MemoryScope | null {
  return SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : null
}

function namespaceTarget(value: unknown): MemoryNamespaceTarget | null {
  if (!isRecord(value)) return null
  switch (value.scope) {
    case "global":
      return { scope: "global" }
    case "workspace": {
      const projectId = id(value.projectId)
      return projectId ? { scope: "workspace", projectId } : null
    }
    case "character": {
      const characterId = id(value.characterId)
      return characterId ? { scope: "character", characterId } : null
    }
    case "agent": {
      const agentId = id(value.agentId)
      return agentId ? { scope: "agent", agentId } : null
    }
    default:
      return null
  }
}

function listQuery(value: unknown): ListMemoriesQuery | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const query: ListMemoriesQuery = {}
  if (value.scope !== undefined) {
    const parsed = scope(value.scope)
    if (!parsed) return null
    query.scope = parsed
  }
  for (const key of ["characterId", "projectId", "agentId"] as const) {
    const parsed = optionalId(value[key])
    if (parsed === null) return null
    if (parsed !== undefined) query[key] = parsed
  }
  if (value.type !== undefined) {
    if (!isMemoryType(value.type)) return null
    query.type = value.type
  }
  if (value.status !== undefined) {
    if (value.status !== "active" && value.status !== "invalidated") return null
    query.status = value.status
  }
  return query
}

/** Parse a wire payload into a console command, or `null` when it is malformed. */
export function parseManageMemoryCommand(value: unknown): ManageMemoryCommand | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case "create": {
      const body = text(value.text)
      const tagList = tags(value.tags)
      const weight = importance(value.importance)
      if (!body || !tagList || weight === null || !isMemoryType(value.type)) return null
      const command: Extract<ManageMemoryCommand, { kind: "create" }> = {
        kind: "create",
        text: body,
        type: value.type,
        importance: weight,
        tags: tagList,
      }
      if (value.scope !== undefined) {
        const parsed = scope(value.scope)
        if (!parsed) return null
        command.scope = parsed
      }
      for (const key of ["characterId", "projectId", "agentId", "branch", "pathPattern"] as const) {
        const parsed = optionalId(value[key])
        if (parsed === null) return null
        if (parsed !== undefined) command[key] = parsed
      }
      return command
    }
    case "update": {
      const target = id(value.id)
      if (!target || !isRecord(value.patch)) return null
      const patch: Extract<ManageMemoryCommand, { kind: "update" }>["patch"] = {}
      if (value.patch.text !== undefined) {
        const body = text(value.patch.text)
        if (!body) return null
        patch.text = body
      }
      if (value.patch.tags !== undefined) {
        const tagList = tags(value.patch.tags)
        if (!tagList) return null
        patch.tags = tagList
      }
      if (value.patch.importance !== undefined) {
        const weight = importance(value.patch.importance)
        if (weight === null) return null
        patch.importance = weight
      }
      if (value.patch.key !== undefined) {
        const key = id(value.patch.key)
        if (!key) return null
        patch.key = key
      }
      return Object.keys(patch).length > 0 ? { kind: "update", id: target, patch } : null
    }
    case "pin": {
      const target = id(value.id)
      return target && typeof value.pinned === "boolean"
        ? { kind: "pin", id: target, pinned: value.pinned }
        : null
    }
    case "review": {
      const target = id(value.id)
      return target && (value.status === "verified" || value.status === "conflict")
        ? { kind: "review", id: target, status: value.status }
        : null
    }
    case "retrieval-feedback": {
      const target = id(value.id)
      const verdict = value.verdict as RetrievalFeedbackVerdict
      return target && RETRIEVAL_FEEDBACK_VERDICTS.includes(verdict)
        ? { kind: "retrieval-feedback", id: target, verdict }
        : null
    }
    case "delete":
    case "restore": {
      const target = id(value.id)
      return target ? { kind: value.kind, id: target } : null
    }
    case "invalidate": {
      const target = id(value.id)
      const supersededById = optionalId(value.supersededById)
      if (!target || supersededById === null) return null
      return supersededById
        ? { kind: "invalidate", id: target, supersededById }
        : { kind: "invalidate", id: target }
    }
    case "restore-revision": {
      const target = id(value.id)
      const revisionId = id(value.revisionId)
      return target && revisionId ? { kind: "restore-revision", id: target, revisionId } : null
    }
    case "relocate": {
      const target = id(value.id)
      const destination = namespaceTarget(value.target)
      return target && destination ? { kind: "relocate", id: target, target: destination } : null
    }
    case "resolve-conflict": {
      const keepId = id(value.keepId)
      const dropId = id(value.dropId)
      const mode = value.mode
      if (!keepId || !dropId || keepId === dropId) return null
      if (mode !== "keep" && mode !== "keep-both" && mode !== "merge") return null
      const command: Extract<ManageMemoryCommand, { kind: "resolve-conflict" }> = {
        kind: "resolve-conflict",
        keepId,
        dropId,
        mode,
      }
      if (mode === "merge") {
        const merged = text(value.mergedText)
        if (!merged) return null
        command.mergedText = merged
      }
      const rationale = value.rationale
      if (rationale !== undefined) {
        if (typeof rationale !== "string" || rationale.length > MAX_TEXT) return null
        command.rationale = rationale
      }
      return command
    }
    case "clear": {
      const query = listQuery(value.query)
      if (query === null) return null
      return query ? { kind: "clear", query } : { kind: "clear" }
    }
    default:
      return null
  }
}
