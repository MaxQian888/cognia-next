import { RpcError } from "./errors"
import { RPC_ERROR_CODES } from "./rpc/protocol"
import type { AgentInput } from "./types"

/**
 * v0.1 carries no attachments.
 *
 * The client schema has always accepted `attachments` with `path` and `data`,
 * and no host code path has ever read them: the turn ran without the file and
 * the caller was told nothing. Rejecting is strictly better than that, and it
 * keeps the door open for the asset-reference contract, where the turn carries
 * `{ assetId, digest, mediaType, byteLength }` and raw bytes never enter the
 * canonical log.
 */
export function assertSupportedInput(input: AgentInput): void {
  if (typeof input === "string") return
  if (!input || typeof input !== "object") {
    throw new RpcError(RPC_ERROR_CODES.invalidParams, "turn input must be a string or an object")
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new RpcError(RPC_ERROR_CODES.invalidParams, "turn input requires a non-empty prompt")
  }
  const attachments = input.attachments
  if (attachments === undefined) return
  if (!Array.isArray(attachments)) {
    throw new RpcError(RPC_ERROR_CODES.invalidParams, "attachments must be an array when present")
  }
  if (attachments.length === 0) return

  const shapes = new Set<string>()
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      shapes.add("unknown")
      continue
    }
    const record = attachment as Record<string, unknown>
    let classified = false
    if (typeof record.path === "string") {
      shapes.add("path")
      classified = true
    }
    if (typeof record.data === "string") {
      shapes.add("data")
      classified = true
    }
    if (!classified) shapes.add("unknown")
  }

  throw new RpcError(
    RPC_ERROR_CODES.invalidParams,
    `turn input carries ${attachments.length} attachment(s) (${[...shapes].sort().join(", ")}); ` +
      "this host build accepts no attachments. They were previously accepted and silently " +
      "dropped. Use asset references once the host declares the assets-v1 capability.",
    { attachmentCount: attachments.length, shapes: [...shapes].sort() }
  )
}
