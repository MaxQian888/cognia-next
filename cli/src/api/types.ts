/**
 * The contract shared by the generated command index, the invoker, and the
 * `api` / derived-resource commands.
 *
 * Every field here comes from a frozen protocol source (see
 * `scripts/build/gen-cli-api-index.mjs`), so a CLI that trusts this table is
 * trusting the same manifest the host dispatcher enforces. That is what lets
 * a bad call fail locally with a fix line instead of arriving as a 422.
 */

/**
 * Which wire carries a command.
 *
 * `internal` is `POST /internal/_rpc/{name}` with a loopback service token:
 * the full plane, with capability and approval checks bypassed by design
 * (`remote_execution.rs` treats a loopback service principal as the policy
 * authority for the Brain plane).
 *
 * `http` is `POST /api/_rpc/{name}` with a DPoP device session: only
 * `execution` / `host-admin` targets, and every capability grant and approval
 * gate applies.
 */
export type ApiWire = "internal" | "http"

export type ApiFlagType = "string" | "boolean" | "integer" | "number" | "json"

export interface ApiCommandFlag {
  /** Request-body property name, verbatim. This is what goes on the wire. */
  name: string
  /**
   * Kebab-case CLI flag, or `""` when the shorthand was withheld because it
   * would collide with a global flag or with another property's flag. Such a
   * field is still reachable through `--data`.
   */
  flag: string
  type: ApiFlagType
  required?: true
  /** The schema accepts an explicit `null`, which usually means "clear this". */
  nullable?: true
  enum?: string[]
  description?: string
}

export interface ApiCommandEntry {
  /** Wire command name, e.g. `plugin_backup_create`. */
  name: string
  /** First `_`-delimited segment, e.g. `plugin`. */
  group: string
  /** Remainder, kebab-cased, e.g. `backup-create`. Empty for one-word names. */
  action: string
  /**
   * The request schema's own prose, when the spec carries any. Only 7 commands
   * do. The per-operation `summary` is deliberately absent: it is always
   * "<name> (<capability>)", which every other field here already says.
   */
  description?: string
  target: "client" | "execution" | "service" | "host-admin"
  capability: string
  risk: "low" | "high" | "critical"
  approval: "none" | "interactive" | "signed-policy"
  idempotency: string
  wires: ApiWire[]
  /**
   * `fields` means the body is a flat object and `flags` describes it.
   * `composed` means the body is a top-level `oneOf`/`anyOf`, so no honest
   * flag set exists and the call must supply `--data`.
   */
  bodyKind: "fields" | "composed"
  flags: ApiCommandFlag[]
  /**
   * Alias requirement groups: at least one name from each group must be
   * present. The specs express "`session_id` or `sessionId`" this way.
   */
  requireOneOf?: string[][]
}
