import type {
  WorkingSetEntryKind,
  WorkingSetEntryOrigin,
  WorkingSetEntryStatus,
} from "@cognia/agent-config-types/working-set"
import type { ResourceRefV1 } from "@cognia/agent-config-types/governance"

import {
  mutateSessionWorkingSet,
  readSessionWorkingSet,
  WorkingSetConflictError,
} from "@/lib/chat/working-set"

export const WORKING_SET_TOOL_NAME = "working_set"
export const WORKING_SET_BUILTIN_PLUGIN_ID = "cognia-working-set-builtin"

export interface WorkingSetManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

export function isWorkingSetTool(name: string): boolean {
  return name === WORKING_SET_TOOL_NAME
}

export function buildWorkingSetManifestEntries(): WorkingSetManifestEntry[] {
  return [
    {
      name: WORKING_SET_TOOL_NAME,
      description:
        "Read or update the bounded, user-visible working set for this chat. Mutations use expectedRevision for compare-and-swap safety.",
      pluginId: WORKING_SET_BUILTIN_PLUGIN_ID,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["get", "upsert", "resolve", "remove"] },
          expectedRevision: { type: "integer", minimum: 0 },
          entryId: { type: "string", minLength: 1 },
          entry: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "summary", "origin"],
            properties: {
              id: { type: "string", minLength: 1 },
              kind: {
                type: "string",
                enum: ["fact", "decision", "open-question", "resource", "subtask"],
              },
              summary: { type: "string", minLength: 1, maxLength: 512 },
              origin: { type: "string", enum: ["user", "agent"] },
              status: { type: "string", enum: ["active", "resolved"] },
              refs: {
                type: "array",
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["namespace", "type", "id"],
                  properties: {
                    namespace: { type: "string", minLength: 1 },
                    type: { type: "string", minLength: 1 },
                    id: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
      },
    },
  ]
}

type ToolContext = { sessionId: string }

function invalidArguments(error: string) {
  return { ok: false as const, code: "invalid_arguments" as const, error }
}

function parseRevision(args: Record<string, unknown>): number | null {
  return Number.isInteger(args.expectedRevision) && (args.expectedRevision as number) >= 0
    ? (args.expectedRevision as number)
    : null
}

export async function runWorkingSetTool(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  const action = args.action
  if (action === "get") {
    return { ok: true as const, workingSet: await readSessionWorkingSet(context.sessionId) }
  }
  if (action !== "upsert" && action !== "resolve" && action !== "remove") {
    return invalidArguments("action must be get, upsert, resolve, or remove")
  }
  const expectedRevision = parseRevision(args)
  if (expectedRevision === null) {
    return invalidArguments("expectedRevision is required for mutations")
  }

  try {
    if (action === "upsert") {
      if (!args.entry || typeof args.entry !== "object" || Array.isArray(args.entry)) {
        return invalidArguments("entry is required for upsert")
      }
      const entry = args.entry as Record<string, unknown>
      if (
        typeof entry.kind !== "string" ||
        typeof entry.summary !== "string" ||
        typeof entry.origin !== "string"
      ) {
        return invalidArguments("entry.kind, entry.summary, and entry.origin are required")
      }
      const workingSet = await mutateSessionWorkingSet({
        sessionId: context.sessionId,
        expectedRevision,
        action,
        entry: {
          ...(typeof entry.id === "string" ? { id: entry.id } : {}),
          kind: entry.kind as WorkingSetEntryKind,
          summary: entry.summary,
          origin: entry.origin as WorkingSetEntryOrigin,
          ...(typeof entry.status === "string"
            ? { status: entry.status as WorkingSetEntryStatus }
            : {}),
          refs: Array.isArray(entry.refs) ? (entry.refs as ResourceRefV1[]) : [],
        },
      })
      return { ok: true as const, workingSet }
    }

    if (typeof args.entryId !== "string" || !args.entryId.trim()) {
      return invalidArguments("entryId is required for resolve and remove")
    }
    const workingSet = await mutateSessionWorkingSet({
      sessionId: context.sessionId,
      expectedRevision,
      action,
      entryId: args.entryId,
    })
    return { ok: true as const, workingSet }
  } catch (error) {
    if (error instanceof WorkingSetConflictError) {
      return {
        ok: false as const,
        code: "revision_conflict" as const,
        error: error.message,
        revision: error.actualRevision,
      }
    }
    return {
      ok: false as const,
      code: "working_set_error" as const,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
