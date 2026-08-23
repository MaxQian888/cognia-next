// file_hash — cryptographic hash of a file (read-only).

import fs from "node:fs"
import crypto from "node:crypto"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { ensureExists } from "../shared/fs-stat.mjs"

const MAX_READ_BYTES = 100 * 1024 * 1024 // 100 MB hard cap (matches Cognia)

const fileHashShape = {
  path: z.string().min(1).describe("Absolute path to the file to hash."),
  algorithm: z
    .enum(["md5", "sha1", "sha256", "sha512"])
    .default("sha256")
    .describe("Hash algorithm. Defaults to sha256."),
}

async function digestFile(filePath, algorithm, bun = globalThis.Bun) {
  if (typeof bun?.CryptoHasher === "function" && typeof bun.file === "function") {
    const hash = new bun.CryptoHasher(algorithm)
    for await (const chunk of bun.file(filePath).stream()) hash.update(chunk)
    return hash.digest("hex")
  }

  const hash = crypto.createHash(algorithm)
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(undefined))
    stream.on("error", reject)
  })
  return hash.digest("hex")
}

async function execFileHash(args) {
  try {
    const st = await ensureExists(args.path)
    if (!st.isFile()) return toolError(`not a regular file: ${args.path}`)
    if (st.size > MAX_READ_BYTES) {
      return toolError(`file too large for hashing: ${st.size} bytes`)
    }
    return toolText({
      path: args.path,
      algorithm: args.algorithm,
      digest: await digestFile(args.path, args.algorithm),
      size: st.size,
    })
  } catch (err) {
    return toolError(err, "file_hash")
  }
}

export const fileHashTool = tool(
  "file_hash",
  "Compute a cryptographic hash of a file (md5/sha1/sha256/sha512). Read-only.",
  fileHashShape,
  execFileHash,
  { alwaysLoad: true }
)

export { digestFile, execFileHash }
