/**
 * `cognia-agent host login <name> --invitation 'cgnp4|…'` (ADR-0224 A2).
 *
 * A pairing invitation printed by `cognia-server pair` or shown as the
 * desktop's QR names everything a login needs: the Host's address, its TLS
 * fingerprint, its tenant, the one-shot owner invitation and, for `cgnp4`, a
 * relay room. The CLI takes the same route the app's pair screen does
 * (`lib/companion/pair-path.ts`): directly when the Host answers on its
 * address, through the relay room when it does not, so a machine on another
 * network can still enroll.
 */

import { choosePairPath, type PairPath, type PairPathOptions } from "@/lib/companion/pair-path"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import type { AuthFetcher } from "@/lib/tauri/companion-auth"
import { createRelayPairFetcher, type RelayPairFetcher } from "@/lib/tauri/relay-pair-fetch"

import type { CliFailure } from "../cli/errors"
import { loginHost, type LoginInput, type LoginResult } from "./login"

/** Whether a `--pair-code` / `--invitation` value is a full invitation. */
export function isPairInvitation(value: string): boolean {
  return /^cgnp\d+\|/.test(value.trim())
}

export interface InvitationLoginInput extends PairPathOptions {
  invitation: string
  displayName?: string
  /** Overrides the invitation's address, e.g. the Host's public URL. */
  endpoint?: string
  /** The direct route's fetcher; pins the Host's TLS key. */
  fetcher?: AuthFetcher
  createRelayFetcher?: typeof createRelayPairFetcher
  /** Injected in tests so no real pairing is attempted. */
  login?: Pick<LoginInput, "fetchConfig" | "register">
}

export type InvitationLoginResult =
  (Extract<LoginResult, { ok: true }> & { path: PairPath }) | Extract<LoginResult, { ok: false }>

function failure(value: CliFailure): InvitationLoginResult {
  return { ok: false, failure: value }
}

export async function loginWithInvitation(
  input: InvitationLoginInput
): Promise<InvitationLoginResult> {
  const decoded = decodePairPayload(input.invitation)
  if (decoded.kind === "wrong_format") {
    return failure({
      error: "this is not a Cognia pairing invitation",
      cause: "invalid-request",
      fix: ["paste the whole cgnp4|… (or cgnp3|…) string `cognia-server pair` printed"],
    })
  }
  if (decoded.kind === "version_mismatch") {
    return failure({
      error: `this invitation is version cgnp${decoded.got}, which this cognia-agent cannot read`,
      cause: "invalid-request",
      fix: ["update cognia-agent to the Host's version, then take a fresh invitation"],
    })
  }
  if (decoded.kind === "invalid") {
    return failure({
      error: `this pairing invitation cannot be used: ${decoded.message}`,
      cause: "invalid-request",
      fix: ["take a fresh invitation: `cognia-server pair` on the host, or its pairing screen"],
    })
  }
  const payload = decoded.payload
  if (payload.mode !== "owner-invitation" || !payload.invitation) {
    return failure({
      error: "this invitation pairs through OIDC sign-in, not an owner invitation",
      cause: "auth",
      fix: ["cognia-agent logto login", "then add the host with --kind device --tenant <id>"],
    })
  }

  const target = input.endpoint ? { ...payload, baseUrl: input.endpoint } : payload
  const path = await choosePairPath(target, input.fetcher, input)
  let room: RelayPairFetcher | null = null
  try {
    let fetcher = input.fetcher
    if (path === "relay" && payload.relay) {
      try {
        room = await (input.createRelayFetcher ?? createRelayPairFetcher)(payload.relay)
      } catch (error) {
        return failure({
          error: `${target.baseUrl} did not answer, and its relay room could not be joined`,
          details: [error instanceof Error ? error.message : String(error)],
          cause: "network",
          fix: [
            "take a fresh invitation; a relay room closes when its invitation expires",
            "or reach the host directly and pass --endpoint <its address>",
          ],
        })
      }
      fetcher = room.fetcher
    }
    const result = await loginHost({
      endpoint: target.baseUrl,
      invitation: payload.invitation,
      tenantId: payload.tenantId,
      ...(payload.fingerprint ? { serverFingerprint: payload.fingerprint } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(fetcher ? { fetcher } : {}),
      ...(input.login ?? {}),
    })
    return result.ok ? { ...result, path } : result
  } finally {
    room?.close()
  }
}
