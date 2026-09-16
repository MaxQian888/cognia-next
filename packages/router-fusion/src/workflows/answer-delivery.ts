/**
 * verified_buffered delivery (DESIGN §15.2, SSE-02).
 *
 * A Run API run's answer is delivered only after it passed the checks its
 * acceptance profile names: the journal carries phase, call and billing events
 * while the run works, and `answer.delta` / `answer.completed` only once the
 * result is final. A panel candidate or a cascade draft that may still be
 * replaced never appears as answer text.
 *
 * The events carry no text. Each `answer.delta` names a byte range of the
 * answer artifact (UTF-8, cut on character boundaries); `answer.completed`
 * names the artifact, its hash and the sealed result record. A reader fetches
 * the content through the artifact API, which re-checks who is asking — the
 * journal itself never holds model output.
 */

import type { RunResult } from "../contracts/schemas"
import type { WorkflowEvent } from "./ports"

/** Target size of one delta, in characters (a delta may run a few bytes longer). */
export const ANSWER_DELTA_CHARS = 2_000

export interface AnswerDeltaPayload {
  artifact_id: string
  index: number
  /** UTF-8 byte offset of the chunk within the artifact. */
  offset: number
  /** UTF-8 byte length of the chunk. */
  length: number
}

/** The UTF-8 byte ranges of `text`, each about `chunkChars` characters, never splitting a character. */
export function answerChunks(
  text: string,
  chunkChars = ANSWER_DELTA_CHARS
): Array<{ offset: number; length: number }> {
  const encoder = new TextEncoder()
  const chunks: Array<{ offset: number; length: number }> = []
  let offset = 0
  let current = ""
  let count = 0
  for (const char of text) {
    current += char
    count++
    if (count >= chunkChars) {
      const length = encoder.encode(current).byteLength
      chunks.push({ offset, length })
      offset += length
      current = ""
      count = 0
    }
  }
  if (current.length > 0) chunks.push({ offset, length: encoder.encode(current).byteLength })
  return chunks
}

export function answerDeliveryEvents(
  result: RunResult,
  resultRecordArtifactId: string,
  chunkChars = ANSWER_DELTA_CHARS
): WorkflowEvent[] {
  const chunks = answerChunks(result.answer, chunkChars)
  return [
    ...chunks.map((chunk, index): WorkflowEvent => ({
      type: "answer.delta",
      payload: {
        artifact_id: result.answer_artifact_id,
        index,
        offset: chunk.offset,
        length: chunk.length,
      } satisfies AnswerDeltaPayload,
    })),
    {
      type: "answer.completed",
      payload: {
        answer_artifact_id: result.answer_artifact_id,
        answer_sha256: result.answer_sha256,
        result_artifact_id: resultRecordArtifactId,
        chunks: chunks.length,
        mode_executed: result.mode_executed,
        quality_status: result.quality_status,
        verification_status: result.verification.status,
        verification_level: result.verification.level,
      },
    },
  ]
}
