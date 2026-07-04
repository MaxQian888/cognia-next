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
    settings,
    lastWhoamiResult: result,
    lastWhoamiAt: now(),
  })

  return result
}
