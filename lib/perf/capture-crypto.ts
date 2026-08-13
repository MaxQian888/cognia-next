import {
  decryptAccountArtifactBytes,
  encryptAccountArtifactBytes,
  type AccountArtifactEncryptedEnvelope,
} from "@/lib/ai/eval/artifact-crypto"
import { assertPerformanceSecurityGeneration } from "./security-generation"

export interface PerformanceArtifactAad {
  accountId: string
  targetDatabase: string
  captureId: string
  ordinal: number
  contentType: string
}

export function encodePerformanceArtifactAad(input: PerformanceArtifactAad): Uint8Array {
  return new TextEncoder().encode(
    [
      "cognia-performance",
      "1",
      input.accountId,
      input.targetDatabase,
      input.captureId,
      String(input.ordinal),
      input.contentType,
    ].join("\u001f")
  )
}

export async function encryptPerformanceArtifact(
  key: Uint8Array,
  plainText: Uint8Array,
  aad: PerformanceArtifactAad,
  securityGeneration: number
): Promise<AccountArtifactEncryptedEnvelope> {
  const envelope = await encryptAccountArtifactBytes(
    key,
    plainText,
    encodePerformanceArtifactAad(aad)
  )
  assertPerformanceSecurityGeneration(securityGeneration)
  return envelope
}

export async function decryptPerformanceArtifact(
  key: Uint8Array,
  envelope: AccountArtifactEncryptedEnvelope,
  aad: PerformanceArtifactAad,
  securityGeneration: number
): Promise<Uint8Array> {
  const value = await decryptAccountArtifactBytes(key, envelope, encodePerformanceArtifactAad(aad))
  assertPerformanceSecurityGeneration(securityGeneration)
  return value
}
