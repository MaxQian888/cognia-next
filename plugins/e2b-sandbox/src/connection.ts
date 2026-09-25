/**
 * E2B connection state: where sandbox API calls would go and where the API
 * key lives, rebuilt from the OS keyring and plugin configuration.
 *
 * The key's durable home is the keyring via `ctx.secrets` (`secrets:write`
 * prompts once per session). A plaintext `apiKey` still sitting in plugin
 * config — a pre-migration install, or a fresh settings save — is moved into
 * the keyring on refresh and the field cleared.
 *
 * Only the E2B workspace backend reads this connection. The MCP server preset
 * runs `@e2b/mcp-server` in its own process with its own `E2B_API_KEY` field:
 * no SDK path lets a preset read a plugin secret, so the settings copy says so.
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import { SECRET_API_KEY } from "./ids"
import type { E2BConnectionStatus } from "./panel-runtime"
import type { E2BSandboxConnection } from "./workspace-backend"

type ConnectionContext = Pick<PluginContext, "configuration" | "secrets" | "logger">

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const INITIAL_CONNECTION_STATUS: E2BConnectionStatus = {
  endpoint: "",
  kind: "cloud",
  apiKey: "missing",
}

export class E2BConnectionState {
  private connection: E2BSandboxConnection = {}
  private currentStatus: E2BConnectionStatus = INITIAL_CONNECTION_STATUS
  /**
   * Once a keyring write fails (consent denied), don't re-prompt on every
   * config change for the rest of this activation.
   */
  private secretsDenied = false
  /** Supersession counter — a slow keyring read must not clobber a newer refresh. */
  private refreshSeq = 0

  /** @param onChange called after every completed refresh (panel re-render). */
  constructor(private readonly onChange: () => void) {}

  /** What the workspace backend hands `Sandbox.create`. */
  get sandboxConnection(): E2BSandboxConnection {
    return this.connection
  }

  /** Last computed panel / command status snapshot. */
  get status(): E2BConnectionStatus {
    return this.currentStatus
  }

  /**
   * Rebuild the connection + status from keyring and config.
   *
   * Migration rule: a non-empty `config.apiKey` means the key is sitting in
   * plaintext plugin config. Move it into `ctx.secrets` once and clear the
   * field; if the write is refused, keep using the plaintext value — the user
   * has a working setup and shouldn't lose it because we couldn't get consent —
   * and report it as `pending` instead of `keyring`.
   *
   * Serialized by `refreshSeq`: `configuration.update` itself fires
   * `onChange`, so a second refresh can start while this one is still
   * awaiting the keyring.
   */
  async refresh(ctx: ConnectionContext): Promise<void> {
    const seq = ++this.refreshSeq
    try {
      const config = ctx.configuration.getAll()
      const plaintext = readString(config.apiKey)
      // `domain` is the native SDK override (e.g. an AgentENV host); `apiUrl`
      // is the user-facing alias — domain wins when both are set.
      const domain = readString(config.domain) ?? readString(config.apiUrl)

      let keyringKey: string | undefined
      try {
        keyringKey = readString(await ctx.secrets.get(SECRET_API_KEY))
      } catch (error) {
        // `secrets:read` refused — fall through to the plaintext value.
        ctx.logger.warn(`e2b-sandbox: could not read the OS keyring (${describeError(error)})`)
        keyringKey = undefined
      }
      if (seq !== this.refreshSeq) return

      if (plaintext && !this.secretsDenied) {
        try {
          if (plaintext !== keyringKey) {
            await ctx.secrets.store(SECRET_API_KEY, plaintext)
            if (seq !== this.refreshSeq) return
          }
          await ctx.configuration.update("apiKey", "")
          if (seq !== this.refreshSeq) return
          keyringKey = plaintext
        } catch (error) {
          this.secretsDenied = true
          ctx.logger.warn(
            `e2b-sandbox: could not move the API key into the OS keyring (${describeError(
              error
            )}) — leaving the settings value in place for this session`
          )
        }
      }

      const apiKey = keyringKey ?? plaintext
      this.connection = {
        ...(apiKey ? { apiKey } : {}),
        ...(domain ? { domain } : {}),
      }
      this.currentStatus = {
        endpoint: domain ?? "",
        kind: domain ? "custom" : "cloud",
        apiKey: keyringKey ? "keyring" : plaintext ? "pending" : "missing",
      }
      this.onChange()
    } catch (error) {
      ctx.logger.warn(`e2b-sandbox: connection refresh failed (${describeError(error)})`)
    }
  }
}
