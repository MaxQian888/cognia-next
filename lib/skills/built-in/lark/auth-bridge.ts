/**
 * Lark-cli auth bridge (ADR-0026).
 *
 * Pulls credentials out of the existing Lark adapter OAuth flow
 * (`lib/connectors/adapters/lark/auth.ts` + `oauth-handler.ts`) and
 * shapes them into env vars the `lark-cli` binary expects so we don't
 * force users to run `lark-cli config init` / `auth login` again.
 *
 * Resolution order:
 *   1. Caller-supplied adapterId (skill ctx)
 *   2. First enabled Lark adapter instance (single-Lark default)
 *   3. Any Lark adapter row even if disabled (so onboarding surfaces a
 *      precise "Lark adapter is disabled — enable it" error)
 *
 * Reads:
 *   - `AdapterInstanceRow.settings.appId`
 *   - keyring `<adapterId>:appSecret`
 *   - keyring `<adapterId>:user_token`         (preferred — narrow scope)
 *   - keyring `<adapterId>:user_refresh_token` (used by future refresh)
 *
 * Never throws on a missing adapter — returns `{ ok: false, reason }`
 * so the skill can show a precise onboarding banner instead of crashing.
 */

import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken } from "@/lib/connectors/adapters/lark/auth"

export type LarkAuthIdentity = "user" | "bot"

export interface LarkAuthBridgeOk {
  ok: true
  /** The adapter row that supplied credentials. */
  adapterId: string
  /** Identity the env will run lark-cli as. */
  identity: LarkAuthIdentity
  /**
   * Env-var overlay to pass to lark-cli. Caller merges this onto
   * `process.env` before `execFile` — see `exec-lark-cli.ts`.
   *
   * Variables:
   *   - `LARK_APP_ID`              app id (cli_...)
   *   - `LARK_APP_SECRET`          app secret (kept in keyring; passed
   *                                ephemerally as env, never written to
   *                                disk by us)
   *   - `LARK_USER_ACCESS_TOKEN`   present only when `identity === "user"`
   *   - `LARK_TENANT_ACCESS_TOKEN` present only when `identity === "bot"`
   *
   * Note: lark-cli reads its own config at `~/.lark-cli/config.json` by
   * default. The env-var path is documented as a fallback in
   * lark-shared SKILL.md; v1 ships env-only. If a deployment env
   * doesn't honour the env-var path, the auth bridge falls back to
   * writing an ephemeral config — wired in v2.
   */
  env: Record<string, string>
}

export type LarkAuthBridgeError =
  | { ok: false; reason: "no_adapter"; message: string }
  | { ok: false; reason: "adapter_disabled"; message: string; adapterId: string }
  | { ok: false; reason: "missing_app_id"; message: string; adapterId: string }
  | { ok: false; reason: "missing_app_secret"; message: string; adapterId: string }
  | { ok: false; reason: "missing_user_token"; message: string; adapterId: string }
  | { ok: false; reason: "tenant_token_failed"; message: string; adapterId: string }

export type LarkAuthBridgeResult = LarkAuthBridgeOk | LarkAuthBridgeError

export interface ResolveLarkAuthInput {
  /**
   * Specific adapter to resolve. When omitted, the bridge picks the
   * first enabled Lark adapter (sufficient for the common single-Lark
   * setup).
   */
  adapterId?: string
  /**
   * Preferred identity:
   *   - `"user"` — uses the OAuth user_access_token; narrower scope,
   *     attributes actions to the connected user. Default.
   *   - `"bot"` — uses the tenant_access_token; broader scope, attributes
   *     actions to the app/bot. Falls back to bot when no user_token is
   *     stored.
   */
  identity?: LarkAuthIdentity
}

export async function resolveLarkAuth(
  input: ResolveLarkAuthInput = {}
): Promise<LarkAuthBridgeResult> {
  const adapter = await pickAdapter(input.adapterId)
  if (!adapter) {
    return {
      ok: false,
      reason: "no_adapter",
      message:
        "No Lark adapter configured. Connect Lark via Settings → Connectors before invoking Lark skills.",
    }
  }
  if (!adapter.enabled) {
    return {
      ok: false,
      reason: "adapter_disabled",
      message: `Lark adapter "${adapter.displayName}" is disabled. Enable it via Settings → Connectors.`,
      adapterId: adapter.id,
    }
  }

  const appId = String(adapter.settings.appId ?? "").trim()
  if (!appId) {
    return {
      ok: false,
      reason: "missing_app_id",
      message: `Lark adapter "${adapter.displayName}" has no appId configured.`,
      adapterId: adapter.id,
    }
  }

  const appSecret = await safeKeyringGet(adapter.id, "appSecret")
  if (!appSecret) {
    return {
      ok: false,
      reason: "missing_app_secret",
      message: `Lark adapter "${adapter.displayName}" has no appSecret in the keyring.`,
      adapterId: adapter.id,
    }
  }

  const preferred = input.identity ?? "user"
  if (preferred === "user") {
    const userToken = await safeKeyringGet(adapter.id, "user_token")
    if (userToken) {
      return {
        ok: true,
        adapterId: adapter.id,
        identity: "user",
        env: {
          LARK_APP_ID: appId,
          LARK_APP_SECRET: appSecret,
          LARK_USER_ACCESS_TOKEN: userToken,
        },
      }
    }
    // Fall through to bot if no user_token — common when the OAuth flow
    // hasn't been completed yet but the app credentials are valid for
    // tenant-scope calls.
  }

  // Bot identity (tenant_access_token).
  try {
    const tenantToken = await getTenantAccessToken({ appId, appSecret })
    return {
      ok: true,
      adapterId: adapter.id,
      identity: "bot",
      env: {
        LARK_APP_ID: appId,
        LARK_APP_SECRET: appSecret,
        LARK_TENANT_ACCESS_TOKEN: tenantToken,
      },
    }
  } catch (err) {
    return {
      ok: false,
      reason: "tenant_token_failed",
      adapterId: adapter.id,
      message:
        err instanceof Error
          ? `Lark tenant token fetch failed: ${err.message}`
          : "Lark tenant token fetch failed.",
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pickAdapter(adapterId: string | undefined) {
  if (adapterId) {
    return getAdapterInstance(adapterId)
  }
  const all = await listAdapterInstancesByType("lark")
  // Prefer enabled rows; fall back to any row so the caller's error
  // message can be precise ("disabled" vs "not configured").
  const enabled = all.find((r) => r.enabled)
  return enabled ?? all[0]
}

async function safeKeyringGet(adapterId: string, key: string): Promise<string | undefined> {
  try {
    const v = await connectorsKeyringGet(adapterId, key)
    return typeof v === "string" && v.length > 0 ? v : undefined
  } catch {
    // Keyring may be unavailable on web shell — fail soft so the caller
    // gets a clean "missing credential" reason.
    return undefined
  }
}
