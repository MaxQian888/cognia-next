/**
 * Desktop device unlock: the secret that opens a local profile without a
 * prompt, held in the native encrypted secret store (ADR-0054).
 *
 * Two shapes share one keyring slot per profile
 * (`desktop-local-account` / `<accountId>`):
 *
 *  - **Device-managed** (`protection: "device"`). Only the reserved
 *    `acct_desktop_local_workspace` a fresh desktop install creates. Its
 *    credential is random, nobody ever typed it, and the stored copy is the
 *    only way in besides the recovery key kept beside it.
 *  - **Remembered** (`rememberOnDevice: true`). Any password profile whose
 *    owner chose "unlock automatically on this device". The slot holds the
 *    password the owner already proved, and the password keeps working on the
 *    lock screen, so a secret store that cannot be read degrades to a prompt
 *    rather than to a dead end.
 *
 * Either way the secret never leaves the native store for browser storage,
 * and neither shape exists outside the desktop shell: a browser has no store
 * whose threat model covers it.
 */

import type { LocalAccountRecord } from "./account-types"
import { isAccountGateForced, isDevLocalAccountEnabled } from "./dev-auto-unlock"
import { getSecret, setSecret, clearSecret, type KeyringRef } from "@/lib/keyring"
import { isTauri } from "@/lib/platform/detect"

export const DESKTOP_LOCAL_ACCOUNT_ID = "acct_desktop_local_workspace"
const SECRET_NAMESPACE = "desktop-local-account"

/** The keyring slot holding one profile's device unlock secret. */
export function deviceUnlockSecretRef(accountId: string): KeyringRef {
  return { namespace: SECRET_NAMESPACE, key: accountId }
}

const RECOVERY_REF: KeyringRef = {
  namespace: SECRET_NAMESPACE,
  key: `${DESKTOP_LOCAL_ACCOUNT_ID}:recovery`,
}

/**
 * May this runtime open profiles from the native secret store?
 *
 * `NEXT_PUBLIC_ACCOUNT_GATE=1` turns it off so the real password gate stays
 * testable, which covers both the device-managed workspace and remembered
 * profiles.
 */
export function isDesktopLocalAccountEnabled(): boolean {
  return isTauri() && !isAccountGateForced()
}

/** Can a profile opt into "unlock automatically on this device" here at all? */
export function isDeviceUnlockSupported(): boolean {
  return isDesktopLocalAccountEnabled()
}

export function isDeviceManagedAccount(
  account: LocalAccountRecord | null | undefined
): account is LocalAccountRecord & { protection: "device" } {
  return account?.id === DESKTOP_LOCAL_ACCOUNT_ID && account.protection === "device"
}

/**
 * Is this the workspace `pnpm tauri dev` provisioned by itself?
 *
 * The desktop counterpart of `isDevLocalAccount`: a development build's
 * auto-created workspace is by construction always a first run, and routing it
 * through onboarding would put the setup wizard in front of every fresh dev
 * profile. Keyed on the reserved id and on `next dev`, so a release build and
 * any profile created by hand keep the real first run.
 */
export function isDevDesktopWorkspace(accountId: string | null | undefined): boolean {
  if (accountId !== DESKTOP_LOCAL_ACCOUNT_ID) return false
  return isTauri() && isDevLocalAccountEnabled()
}

/** A password profile whose owner chose to unlock it automatically on this device. */
export function isRememberedOnDevice(
  account: LocalAccountRecord | null | undefined
): account is LocalAccountRecord {
  if (!account || isDeviceManagedAccount(account)) return false
  return account.rememberOnDevice === true
}

/**
 * Does this profile open without a prompt on this device?
 *
 * The one predicate every lock affordance consults (Lock buttons, idle lock,
 * account switching): a profile that reopens itself on the next reload gains
 * nothing from being locked, so offering the button would be theatre.
 */
export function unlocksWithoutPrompt(account: LocalAccountRecord | null | undefined): boolean {
  if (!isDesktopLocalAccountEnabled()) return false
  return isDeviceManagedAccount(account) || isRememberedOnDevice(account)
}

/**
 * Read a profile's device unlock secret.
 *
 * Strict: a store that cannot be read throws rather than reading as "absent",
 * because absence is what licenses provisioning a fresh credential, and a
 * locked store must never be mistaken for permission to replace one.
 */
export async function readDeviceUnlockSecret(accountId: string): Promise<string | null> {
  if (!isTauri()) return null
  return getSecret(deviceUnlockSecretRef(accountId), { strict: true })
}

/** Store the secret a profile will open with. Desktop only. */
export async function saveDeviceUnlockSecret(accountId: string, secret: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("Automatic unlock requires the desktop credential store.")
  }
  if (!secret) throw new Error("A device unlock secret cannot be empty.")
  await setSecret(deviceUnlockSecretRef(accountId), secret)
}

/** Forget a profile's device unlock secret. Idempotent, strict on failure. */
export async function clearDeviceUnlockSecret(accountId: string): Promise<void> {
  if (isTauri()) await clearSecret(deviceUnlockSecretRef(accountId), { strict: true })
}

/** Only fresh profile provisioning may mint a secret; resume must never replace one. */
export async function desktopLocalAccountPassword(create = false): Promise<string | null> {
  if (!isTauri()) return null
  const existing = await readDeviceUnlockSecret(DESKTOP_LOCAL_ACCOUNT_ID)
  if (existing || !create) return existing
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const password = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  await saveDeviceUnlockSecret(DESKTOP_LOCAL_ACCOUNT_ID, password)
  return password
}

export async function clearDesktopLocalAccountPassword(): Promise<void> {
  await clearDeviceUnlockSecret(DESKTOP_LOCAL_ACCOUNT_ID)
}

export async function saveDesktopLocalAccountRecoveryKey(recoveryKey: string): Promise<void> {
  if (!isTauri()) throw new Error("Device-managed recovery requires the desktop credential store.")
  await setSecret(RECOVERY_REF, recoveryKey)
}

export async function readDesktopLocalAccountRecoveryKey(): Promise<string | null> {
  return isTauri() ? getSecret(RECOVERY_REF, { strict: true }) : null
}

export async function clearDesktopLocalAccountRecoveryKey(): Promise<void> {
  if (isTauri()) await clearSecret(RECOVERY_REF, { strict: true })
}
