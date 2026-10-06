/**
 * Native device unlock: the secret that opens a local profile without a
 * prompt, held in the native encrypted secret store (ADR-0054).
 *
 * Two shapes share one keyring slot per profile
 * (`desktop-local-account` / `<localAccountId>`):
 *
 *  - **Device-managed** (`protection: "device"`). The reserved desktop workspace
 *    and historical mobile account namespace. Its
 *    credential is random, nobody ever typed it, and the stored copy is the
 *    only way in besides the recovery key kept beside it.
 *  - **Remembered** (`rememberOnDevice: true`). Any password profile whose
 *    owner chose "unlock automatically on this device". The slot holds the
 *    password the owner already proved, and the password keeps working on the
 *    lock screen, so a secret store that cannot be read degrades to a prompt
 *    rather than to a dead end.
 *
 * Either way the secret never leaves the native store for browser storage.
 * The device-managed workspace uses a separate reserved id on each native shell.
 * A remembered profile also works in the native mobile app, where the slot lives in the
 * platform's own secure storage (Android Keystore / iOS Keychain, through
 * `capacitor-secure-storage-plugin`) instead of the desktop secret store. A
 * plain browser has no store whose threat model covers it, so it gets neither.
 */

import type { LocalAccountRecord } from "./account-types"
import { isAccountGateForced, isDevLocalAccountEnabled } from "./dev-auto-unlock"
import { getSecret, setSecret, clearSecret, type KeyringRef } from "@/lib/keyring"
import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { isNativeMobile, isTauri } from "@/lib/platform/detect"

export const DESKTOP_LOCAL_ACCOUNT_ID = "acct_desktop_local_workspace"
// Historical companion namespace; importing active-account-id here would cycle through DB boot.
const MOBILE_LOCAL_ACCOUNT_ID = "local_acct_a"
const SECRET_NAMESPACE = "desktop-local-account"

/** The keyring slot holding one profile's device unlock secret. */
export function deviceUnlockSecretRef(localAccountId: string): KeyringRef {
  return { namespace: SECRET_NAMESPACE, key: localAccountId }
}

function recoveryRef(): KeyringRef {
  return { namespace: SECRET_NAMESPACE, key: `${deviceLocalAccountId()}:recovery` }
}

/** Keep existing mobile pairings in their historical account namespace. */
export function deviceLocalAccountId(): string {
  return isNativeMobile() ? MOBILE_LOCAL_ACCOUNT_ID : DESKTOP_LOCAL_ACCOUNT_ID
}

export function isDeviceLocalAccountEnabled(): boolean {
  return (isTauri() || isNativeMobile()) && !isAccountGateForced()
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

/**
 * Can a profile opt into "unlock automatically on this device" here at all?
 *
 * The desktop shell and the native mobile app, both of which have a hardware-
 * or OS-backed secret store. Never a plain browser.
 */
export function isDeviceUnlockSupported(): boolean {
  return (isTauri() || isNativeMobile()) && !isAccountGateForced()
}

export function isDeviceManagedAccount(
  account: LocalAccountRecord | null | undefined
): account is LocalAccountRecord & { protection: "device" } {
  return (
    (account?.id === DESKTOP_LOCAL_ACCOUNT_ID || account?.id === MOBILE_LOCAL_ACCOUNT_ID) &&
    account.protection === "device"
  )
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
export function isDevDesktopWorkspace(localAccountId: string | null | undefined): boolean {
  if (localAccountId !== DESKTOP_LOCAL_ACCOUNT_ID) return false
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
  if (isDeviceManagedAccount(account))
    return account.id === deviceLocalAccountId() && isDeviceLocalAccountEnabled()
  return isDeviceUnlockSupported() && isRememberedOnDevice(account)
}

// Minimal slice of capacitor-secure-storage-plugin. Resolved through the
// shared loader, which reads the proxy `registerNativePlugins()` installs on
// `window.Capacitor.Plugins` first: the npm package is not in the static
// export, so a bare dynamic import never resolves inside the WebView.
interface MobileSecureStorage {
  get(options: { key: string }): Promise<{ value: string }>
  set(options: { key: string; value: string }): Promise<{ value: boolean }>
  remove(options: { key: string }): Promise<{ value: boolean }>
}

const resolveMobileSecureStorage = makeDefaultLoader<MobileSecureStorage>(
  "capacitor-secure-storage-plugin",
  "SecureStoragePlugin"
)

async function loadMobileSecureStorage(): Promise<MobileSecureStorage> {
  // Account boot precedes CompanionBootProvider, which normally wires proxies.
  if (
    !(globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor?.Plugins
      ?.SecureStoragePlugin
  ) {
    const { registerNativePlugins } = await import("@/lib/capacitor/register-plugins")
    await registerNativePlugins()
  }
  return resolveMobileSecureStorage()
}

/**
 * Both native implementations reject a missing key with this exact message
 * (Android `SecureStoragePluginPlugin.java`, iOS `SecureStoragePlugin.swift`).
 * It is the only rejection that means "absent"; anything else is a store that
 * could not be read, and strict callers must see it as such.
 */
const MOBILE_MISSING_KEY = /item with given key does not exist/i

function mobileStorageKey(ref: KeyringRef): string {
  return `cognia.${ref.namespace}.${ref.key}`
}

function rejectionMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

async function readMobileSecret(ref: KeyringRef): Promise<string | null> {
  const storage = await loadMobileSecureStorage()
  try {
    const { value } = await storage.get({ key: mobileStorageKey(ref) })
    return value || null
  } catch (error) {
    if (MOBILE_MISSING_KEY.test(rejectionMessage(error))) return null
    throw error
  }
}

async function writeMobileSecret(ref: KeyringRef, value: string): Promise<void> {
  const storage = await loadMobileSecureStorage()
  await storage.set({ key: mobileStorageKey(ref), value })
}

async function removeMobileSecret(ref: KeyringRef): Promise<void> {
  const storage = await loadMobileSecureStorage()
  try {
    await storage.remove({ key: mobileStorageKey(ref) })
  } catch (error) {
    if (!MOBILE_MISSING_KEY.test(rejectionMessage(error))) throw error
  }
}

/**
 * Read a profile's device unlock secret.
 *
 * Strict: a store that cannot be read throws rather than reading as "absent",
 * because absence is what licenses provisioning a fresh credential, and a
 * locked store must never be mistaken for permission to replace one.
 */
export async function readDeviceUnlockSecret(localAccountId: string): Promise<string | null> {
  const ref = deviceUnlockSecretRef(localAccountId)
  if (isTauri()) return getSecret(ref, { strict: true })
  if (isNativeMobile()) return readMobileSecret(ref)
  return null
}

/** Store the secret a profile will open with. Desktop and native mobile only. */
export async function saveDeviceUnlockSecret(
  localAccountId: string,
  secret: string
): Promise<void> {
  if (!isTauri() && !isNativeMobile()) {
    throw new Error("Automatic unlock requires this device's secure credential store.")
  }
  if (!secret) throw new Error("A device unlock secret cannot be empty.")
  const ref = deviceUnlockSecretRef(localAccountId)
  if (isTauri()) await setSecret(ref, secret)
  else await writeMobileSecret(ref, secret)
}

/** Forget a profile's device unlock secret. Idempotent, strict on failure. */
export async function clearDeviceUnlockSecret(localAccountId: string): Promise<void> {
  const ref = deviceUnlockSecretRef(localAccountId)
  if (isTauri()) await clearSecret(ref, { strict: true })
  else if (isNativeMobile()) await removeMobileSecret(ref)
}

/** Only fresh profile provisioning may mint a secret; resume must never replace one. */
export async function desktopLocalAccountPassword(create = false): Promise<string | null> {
  if (!isTauri() && !isNativeMobile()) return null
  const existing = await readDeviceUnlockSecret(deviceLocalAccountId())
  if (existing || !create) return existing
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const password = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  await saveDeviceUnlockSecret(deviceLocalAccountId(), password)
  return password
}

export async function clearDesktopLocalAccountPassword(): Promise<void> {
  await clearDeviceUnlockSecret(deviceLocalAccountId())
}

export async function saveDesktopLocalAccountRecoveryKey(recoveryKey: string): Promise<void> {
  if (isTauri()) await setSecret(recoveryRef(), recoveryKey)
  else if (isNativeMobile()) await writeMobileSecret(recoveryRef(), recoveryKey)
  else throw new Error("Device-managed recovery requires a native credential store.")
}

export async function readDesktopLocalAccountRecoveryKey(): Promise<string | null> {
  if (isTauri()) return getSecret(recoveryRef(), { strict: true })
  return isNativeMobile() ? readMobileSecret(recoveryRef()) : null
}

export async function clearDesktopLocalAccountRecoveryKey(): Promise<void> {
  if (isTauri()) await clearSecret(recoveryRef(), { strict: true })
  else if (isNativeMobile()) await removeMobileSecret(recoveryRef())
}
