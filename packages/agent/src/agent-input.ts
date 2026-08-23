import { CAP_ASSETS_IN_TURN_V1, hasCapability } from "./capabilities"
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
export function assertSupportedInput(
  input: AgentInput,
  hostCapabilities: readonly string[] = []
): void {
  if (typeof input === "string") return
  if (!input || typeof input !== "object") {
    throw new RpcError(RPC_ERROR_CODES.invalidParams, "turn input must be a string or an object")
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new RpcError(RPC_ERROR_CODES.invalidParams, "turn input requires a non-empty prompt")
  }
  const assets = input.assets
  if (assets !== undefined) {
    if (!Array.isArray(assets)) {
      throw new RpcError(RPC_ERROR_CODES.invalidParams, "assets must be an array when present")
    }
    if (assets.length > 0 && !hasCapability(hostCapabilities, CAP_ASSETS_IN_TURN_V1)) {
      throw new RpcError(
        RPC_ERROR_CODES.capabilityError,
        `turn input carries ${assets.length} asset reference(s) but the host does not declare ` +
          `${CAP_ASSETS_IN_TURN_V1}. This host can store assets, but its agent runtime cannot ` +
          "read one during a turn yet, and accepting the reference would mean dropping it."
      )
    }
    assets.forEach((asset, index) => {
      if (!asset || typeof asset !== "object") {
        throw new RpcError(RPC_ERROR_CODES.invalidParams, `assets[${index}] must be an object`)
      }
      const record = asset as unknown as Record<string, unknown>
      for (const key of ["assetId", "digest", "mediaType"]) {
        if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
          throw new RpcError(
            RPC_ERROR_CODES.invalidParams,
            `assets[${index}].${key} must be a non-empty string`
          )
        }
      }
      if (typeof record.byteLength !== "number" || record.byteLength < 0) {
        throw new RpcError(
          RPC_ERROR_CODES.invalidParams,
          `assets[${index}].byteLength must be a non-negative number`
        )
      }
      // A raw path or blob smuggled onto a reference would defeat the point.
      for (const forbidden of ["path", "data", "contents"]) {
        if (record[forbidden] !== undefined) {
          throw new RpcError(
            RPC_ERROR_CODES.invalidParams,
            `assets[${index}].${forbidden} is not part of an asset reference; a turn carries the ` +
              "reference only, never bytes or host paths"
          )
        }
      }
    })
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
      "dropped. Upload the bytes with client.assets and pass `assets` instead.",
    { attachmentCount: attachments.length, shapes: [...shapes].sort() }
  )
}
