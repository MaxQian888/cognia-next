/** Shared secure storage for the Standard Webhooks signing secret. */

import { createKeyringStore } from "@/lib/credentials/keyring-store"

const signingSecrets = createKeyringStore("webhooks")
const SIGNING_SECRET_KEY = "standard-signing-secret"

export async function getWebhookSigningSecret(): Promise<string | null> {
  return signingSecrets.load(SIGNING_SECRET_KEY)
}

export async function setWebhookSigningSecret(secret: string | null): Promise<void> {
  if (secret === null || secret.length === 0) {
    await signingSecrets.delete(SIGNING_SECRET_KEY)
    return
  }
  await signingSecrets.save(SIGNING_SECRET_KEY, secret)
}
