/** Shared setup for the enrollment module tests (not shipped). */

import type { DevicePlatform } from "@cognia/sync-protocol"

import {
  createFakeSyncServer,
  type FakeSyncServer,
  type FakeSyncServerOptions,
} from "../testing/fake-sync-server"
import { createMemoryKeyring } from "../testing/memory-keyring"
import { createAccountSyncVault } from "../vault-store"
import { createAccountSyncContext, type AccountSyncContext } from "./context"
import { commitFirstDevice, prepareFirstDevice } from "./first-device"

export const TEST_SPACE = "s".repeat(43)

export function testServer(options: Partial<FakeSyncServerOptions> = {}): FakeSyncServer {
  return createFakeSyncServer({ spaceId: TEST_SPACE, ...options })
}

export function testContext(
  server: FakeSyncServer,
  name: string,
  fetchImpl: typeof fetch = server.fetch
): AccountSyncContext {
  return createAccountSyncContext(
    {
      localAccountId: `local_${name}`,
      issuer: "https://id.test/api/auth",
      userId: "usr_person",
      spaceId: TEST_SPACE,
      syncUrl: "https://sync.test",
      accessToken: async () => "token",
    },
    {
      fetchImpl,
      vault: createAccountSyncVault(
        { localAccountId: `local_${name}`, spaceId: TEST_SPACE },
        createMemoryKeyring()
      ),
    }
  )
}

export const identity = (name: string, platform: DevicePlatform = "web") => ({ name, platform })

/** A space whose first device is `name`; returns its context and recovery key. */
export async function spaceWithFirstDevice(server: FakeSyncServer, name = "first") {
  const context = testContext(server, name)
  const prepared = await prepareFirstDevice(context, identity(name, "desktop"))
  const recoveryKeyText = prepared.recoveryKeyText
  await commitFirstDevice(context, prepared)
  const device = (await context.vault.loadDeviceKeys())!
  return { context, device, recoveryKeyText }
}
