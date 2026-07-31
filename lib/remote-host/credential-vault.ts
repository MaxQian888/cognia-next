import { clearSecret, getSecret, setSecret } from "@/lib/keyring"

const NAMESPACE = "remote-host"

export interface RemoteHostCredential {
  deviceJwt: string
  signalingPrivateKeyJwk?: JsonWebKey
}

export function remoteHostCredentialRef(hostId: string): string {
  return `${NAMESPACE}:${hostId}`
}

export async function saveRemoteHostCredential(
  hostId: string,
  credential: RemoteHostCredential
): Promise<string> {
  if (!credential.deviceJwt) throw new Error("Remote host credential requires a device token")
  await setSecret(
    { namespace: NAMESPACE, key: hostId },
    JSON.stringify({
      deviceJwt: credential.deviceJwt,
      ...(credential.signalingPrivateKeyJwk
        ? { signalingPrivateKeyJwk: credential.signalingPrivateKeyJwk }
        : {}),
    })
  )
  return remoteHostCredentialRef(hostId)
}

export async function loadRemoteHostCredential(
  hostId: string
): Promise<RemoteHostCredential | null> {
  const raw = await getSecret({ namespace: NAMESPACE, key: hostId })
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteHostCredential>
    if (typeof parsed.deviceJwt !== "string" || parsed.deviceJwt.length === 0) return null
    return {
      deviceJwt: parsed.deviceJwt,
      ...(parsed.signalingPrivateKeyJwk && typeof parsed.signalingPrivateKeyJwk === "object"
        ? { signalingPrivateKeyJwk: parsed.signalingPrivateKeyJwk }
        : {}),
    }
  } catch {
    return null
  }
}

export async function clearRemoteHostCredential(hostId: string): Promise<void> {
  await clearSecret({ namespace: NAMESPACE, key: hostId })
}
