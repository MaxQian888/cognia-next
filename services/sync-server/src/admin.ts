/**
 * `SyncAdmin`: the purge hook the identity Worker calls over a service
 * binding (never routed over HTTP) when an account's deletion cooling-off
 * period ends. It deletes the whole space: registry, envelopes, requests.
 */

import { WorkerEntrypoint } from "cloudflare:workers"

import { spaceIdFor } from "@cognia/sync-protocol"

import { readConfig } from "./config"
import type { Env } from "./env"

const USER_ID = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/

export async function purgeSpaceOf(env: Env, userId: string): Promise<{ spaceId: string }> {
  if (!USER_ID.test(userId)) throw new Error("not a usr_ id")
  const spaceId = await spaceIdFor(readConfig(env).issuer, userId)
  await env.SYNC_SPACE.get(env.SYNC_SPACE.idFromName(spaceId)).purge()
  return { spaceId }
}

export class SyncAdmin extends WorkerEntrypoint<Env> {
  purgeSpace(userId: string): Promise<{ spaceId: string }> {
    return purgeSpaceOf(this.env, userId)
  }
}
