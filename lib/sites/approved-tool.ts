import { findApprovedBinary, recordBinaryApproval } from "@/lib/db/approved-binaries"
import { hashBinaryFile } from "@/lib/plugin/security/binary-hash"

const SITES_TOOL_LEDGER_ID = "builtin:cognia-sites"

export async function approveSiteProviderTool(binaryPath: string): Promise<string> {
  if (!binaryPath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(binaryPath)) {
    throw new Error("Sites provider tool path must be absolute")
  }
  const sha256 = await hashBinaryFile(binaryPath)
  if (!sha256) throw new Error("Sites provider tool could not be hashed")
  await recordBinaryApproval({ pluginId: SITES_TOOL_LEDGER_ID, binaryPath, sha256 })
  return sha256
}

export async function assertApprovedSiteProviderTool(binaryPath: string): Promise<void> {
  const [approval, currentHash] = await Promise.all([
    findApprovedBinary(SITES_TOOL_LEDGER_ID, binaryPath),
    hashBinaryFile(binaryPath),
  ])
  if (!approval || !currentHash || approval.sha256 !== currentHash) {
    throw new Error("Sites provider tool is not approved or its bytes changed")
  }
}
