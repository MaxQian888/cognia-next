// Aider session-history source (ADR-0062, T3).
//
// The chat-history format itself is read by `@cognia/agent-aider/history`
// (ADR-0217): this module owns only what the host decides — that Aider
// histories are picker-only (Aider appends to `<repo>/.aider.chat.history.md`,
// so there is no machine-wide location to walk) and how a parsed transcript
// becomes app rows and an imported session graph.

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import {
  AIDER_HISTORY_FORMAT,
  AIDER_HISTORY_LOSSES,
  detectAiderHistory,
  parseAiderHistory as readAiderHistory,
  summarizeAiderHistory,
} from "@cognia/agent-aider/history"
import { buildSession, importedSessionId } from "../to-parts"
import { buildImportedSessionGraph } from "../graph"
import { historyMessagesToStored, historySummaryToSessionSummary } from "../history-to-stored"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
} from "../types"

interface ParsedSession {
  originalSessionId: string
  title: string
  messages: StoredMessage[]
  createdAt: number
  updatedAt: number
}

export function parseAiderHistory(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const parsed = readAiderHistory(content, locatorId)
  return {
    originalSessionId: parsed.originalSessionId,
    title: parsed.title,
    messages: historyMessagesToStored(
      importedSessionId(parsed.sourceId, parsed.originalSessionId),
      parsed.messages,
      projectId
    ),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  }
}

function toConversation(parsed: ParsedSession): ImportedConversation {
  const id = importedSessionId("aider", parsed.originalSessionId)
  const session = buildSession({
    id,
    title: parsed.title,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
  })
  return { session, messages: parsed.messages }
}

export const aiderSessionSource: AgentSessionSourceAdapter = {
  id: AIDER_HISTORY_FORMAT.sourceId,
  displayName: "Aider",
  labelKey: "aider",
  verifiedVersion: AIDER_HISTORY_FORMAT.verifiedVersion,
  verifiedAt: AIDER_HISTORY_FORMAT.verifiedAt,
  acceptedExtensions: [...AIDER_HISTORY_FORMAT.acceptedExtensions],

  // Aider appends to `<repo>/.aider.chat.history.md`: there is no machine-wide
  // location to walk, so this source is picker-only BY DESIGN — declared, not
  // merely implied by an empty `scanRoots`, so the dialog can say so.
  pickerOnly: true,
  scanRoots() {
    return []
  },

  detect(files: PickedSessionFile[]) {
    return detectAiderHistory(files)
  },

  async listSessions(input: SessionScanInput) {
    if (!input.pickedFiles?.length) return [] // no scan root
    return input.pickedFiles
      .filter((f) => f.name.toLowerCase().endsWith(".md"))
      .map((f) => historySummaryToSessionSummary(summarizeAiderHistory(f.content, f.path), f.path))
      .filter((s) => s.messageCount > 0)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    let content: string
    if (input.pickedFiles?.length) {
      content = input.pickedFiles.find((f) => f.path === ref.locator)?.content ?? ""
    } else {
      content = await input.fs.readTextFile(ref.locator)
    }
    return toConversation(parseAiderHistory(content, ref.locator))
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const graph = buildImportedSessionGraph(await this.parseSession(ref, input), {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: "contextual",
    })
    for (const node of graph.nodes) {
      node.loss.losses.push(...AIDER_HISTORY_LOSSES.map((loss) => ({ ...loss })))
    }
    return graph
  },
}
