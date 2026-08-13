import {
  createProfileDekStore,
  type PortableProfileDekEnvelopeV1,
} from "@/lib/rag/profile-dek-store"
import { canonicalStringify } from "./migrate"
import { sha256Hex } from "./crypto"
import type { BackupPackageV3 } from "./types"

export const LEGACY_PORTABLE_RETRIEVAL_PROFILE_IDS = ["chat-shared", "memory-shared"] as const

type ProfileDekStore = ReturnType<typeof createProfileDekStore>
export type PortableExportStore = Pick<ProfileDekStore, "listProfileIds" | "exportPortable">
export type PortableImportStore = Pick<ProfileDekStore, "importPortableBatch">

export async function exportPortableRetrievalKeys(
  passphrase: string,
  store: PortableExportStore = createProfileDekStore()
): Promise<PortableProfileDekEnvelopeV1[]> {
  if (!passphrase) throw new Error("A backup passphrase is required")
  const profileIds = await store.listProfileIds(LEGACY_PORTABLE_RETRIEVAL_PROFILE_IDS)
  return Promise.all(profileIds.map((profileId) => store.exportPortable(profileId, passphrase)))
}

export async function attachPortableRetrievalKeys(
  pkg: BackupPackageV3,
  passphrase: string,
  store: PortableExportStore = createProfileDekStore()
): Promise<BackupPackageV3> {
  const retrievalProfileDeks = await exportPortableRetrievalKeys(passphrase, store)
  const payload = {
    ...pkg.payload,
    ...(retrievalProfileDeks.length > 0 ? { retrievalProfileDeks } : {}),
  }
  return {
    ...pkg,
    manifest: {
      ...pkg.manifest,
      integrity: {
        algorithm: "SHA-256",
        checksum: await sha256Hex(canonicalStringify(payload)),
      },
    },
    payload,
  }
}

export async function importPortableRetrievalKeys(
  envelopes: readonly PortableProfileDekEnvelopeV1[] | undefined,
  passphrase: string | undefined,
  store: PortableImportStore = createProfileDekStore()
): Promise<string[]> {
  if (!envelopes || envelopes.length === 0) return []
  if (!passphrase) throw new Error("A backup passphrase is required to restore retrieval keys")
  await store.importPortableBatch(envelopes, passphrase, { activate: "if-missing" })
  return envelopes.map(({ profileId }) => profileId).sort()
}
