import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type EncryptedContentEnvelopeV1,
} from "@cognia/rag"
import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import type { HumanInputValue } from "@/types/workflow/human-input"

export const HUMAN_INPUT_KEY_ID = "human-input-v1"

export interface HumanInputCryptoScope {
  accountId: string
  requestId: string
  responderId: string
}

export interface HumanInputCryptoDeps {
  loadKey?: (accountId: string) => Promise<Uint8Array>
}

export function humanInputAad(scope: HumanInputCryptoScope): string {
  return `human-input-v1:${scope.accountId}:${scope.requestId}:${scope.responderId}`
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function resolveKey(
  accountId: string,
  usage: KeyUsage,
  deps: HumanInputCryptoDeps
): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for Human Input")
  const raw = deps.loadKey
    ? await deps.loadKey(accountId)
    : await loadOrCreateAccountArtifactKey(accountId, "human-input")
  return globalThis.crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, [
    usage,
  ])
}

export async function sealHumanInputValues(
  values: Record<string, HumanInputValue>,
  scope: HumanInputCryptoScope,
  deps: HumanInputCryptoDeps = {}
): Promise<EncryptedContentEnvelopeV1> {
  const key = await resolveKey(scope.accountId, "encrypt", deps)
  return encryptContentEnvelope(JSON.stringify(values), {
    key,
    keyId: HUMAN_INPUT_KEY_ID,
    additionalData: humanInputAad(scope),
  })
}

export async function openHumanInputValues(
  envelope: EncryptedContentEnvelopeV1,
  scope: HumanInputCryptoScope,
  deps: HumanInputCryptoDeps = {}
): Promise<Record<string, HumanInputValue>> {
  const key = await resolveKey(scope.accountId, "decrypt", deps)
  const plainText = await decryptContentEnvelope(envelope, {
    key,
    additionalData: humanInputAad(scope),
  })
  const parsed: unknown = JSON.parse(plainText)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Human Input sensitive envelope is malformed")
  }
  return parsed as Record<string, HumanInputValue>
}
