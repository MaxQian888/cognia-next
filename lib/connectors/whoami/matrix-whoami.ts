/**
 * Matrix bot identity probe.
 *
 * Calls Matrix `/_matrix/client/v3/account/whoami` with the adapter access
 * token and persists the result into `adapterInstances.lastWhoamiResult`.
 * The returned `device_id` is also copied into `settings.deviceId` so the
 * E2EE OlmMachine can bind to the same Matrix device that owns the token.
 */

import { matrixWhoamiDetailed, normalizeHomeserver } from "@/lib/connectors/adapters/matrix/auth"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { buildSelfIdentity } from "@/lib/connectors/self-identity"
import type { AdapterSelfIdentitySnapshot } from "@/lib/db/connector-types"

export interface MatrixWhoamiResult {
  botName: string
  appId: string
  openId: string
  deviceId?: string
}

export class MatrixWhoamiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = "MatrixWhoamiError"
  }
}

export interface ProbeMatrixOptions {
  now?: () => number
  /**
   * Which probe is asking. Defaults to `"whoami"` (the settings panel);
   * the supervisor passes `"startup_probe"` when confirming identity as
   * part of starting the adapter. Recorded on the identity snapshot so an
   * operator can tell a confirmed-at-start bot from one that has only ever
   * been probed by hand.
   */
  source?: AdapterSelfIdentitySnapshot["source"]
}

function localpart(userId: string): string {
  const m = /^@([^:]+):/.exec(userId)
  return m ? m[1] : userId
}

export async function probeMatrixIdentity(
  adapterId: string,
  options: ProbeMatrixOptions = {}
): Promise<MatrixWhoamiResult> {
  const now = options.now ?? Date.now

  const row = await getAdapterInstance(adapterId)
  if (!row) throw new MatrixWhoamiError(`Adapter ${adapterId} does not exist`)
  if (row.type !== "matrix") {
    throw new MatrixWhoamiError(`Adapter ${adapterId} is type=${row.type}, expected "matrix"`)
  }

  const homeserver = normalizeHomeserver(
    ((row.settings ?? {}) as { homeserver?: string }).homeserver ?? ""
  )
  if (!homeserver) {
    throw new MatrixWhoamiError(`Homeserver URL is not configured for adapter ${adapterId}`)
  }

  const token = await connectorsKeyringGet(adapterId, "accessToken")
  if (!token) {
    throw new MatrixWhoamiError(`Access token is not configured for adapter ${adapterId}`)
  }

  const identity = await matrixWhoamiDetailed(homeserver, token)
  if (!identity) {
    throw new MatrixWhoamiError("Matrix whoami returned no identity")
  }

  const result: MatrixWhoamiResult = {
    botName: localpart(identity.userId),
    appId: homeserver,
    openId: identity.userId,
    ...(identity.deviceId ? { deviceId: identity.deviceId } : {}),
  }

  const settings = {
    ...(row.settings ?? {}),
    ...(identity.deviceId ? { deviceId: identity.deviceId } : {}),
  }

  await updateAdapterInstance(adapterId, {
    // The sibling-bot guard's authority — see `lib/connectors/self-identity.ts`.
    selfIdentity: buildSelfIdentity(
      {
        platformAccountId: result.openId,
        source: options.source ?? "whoami",
      },
      now
    ),
    settings,
    lastWhoamiResult: result,
    lastWhoamiAt: now(),
  })

  return result
}
