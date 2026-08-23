/**
 * Remote document provider contracts (ADR-0134).
 *
 * A `DocsProvider` answers three questions about documents that live in a
 * third-party cloud (Feishu/Lark 云文档, Google Workspace) and therefore have
 * no local path the agent's Read tool could open:
 *
 *   1. `matchRef`  — is this pasted string one of mine, and what does it point at?
 *   2. `search`    — what do I have matching these keywords? (optional)
 *   3. `fetch`     — give me the body as text.
 *
 * Deliberately NOT part of `PlatformAdapter` (`types/connectors/adapter.ts`):
 * ADR-0009 confines that contract to IM conversation semantics, and a Google
 * Docs reader has no `send`, no `health`, and no A2UI matrix. This registry is
 * a sibling of Platform Connectors, not an extension of it — though the Lark
 * provider reuses a connector instance's credentials, because that is where
 * the user's Feishu account already lives.
 *
 * Providers are pure retrieval. Nothing here calls a model; the text a
 * provider returns is staged as a composer attachment and passes through the
 * existing `lib/chat/attachments/dispatch.ts` redaction gate before it can
 * reach one.
 */

import type { Platform } from "@/lib/platform/detect"

/**
 * What a reference points at.
 *
 * `wiki` is a Feishu wiki node — an indirection that resolves to a `doc` at
 * fetch time, kept distinct because the picker shows it differently and the
 * token namespaces differ.
 */
export type RemoteDocKind = "doc" | "wiki" | "sheet" | "bitable" | "resource"

/** Body formats a provider may return. Drives the staged attachment's extension. */
export type RemoteDocFormat = "markdown" | "text" | "csv"

/**
 * A pointer to one remote document. Cheap to produce — `search` and `matchRef`
 * both return these without fetching a body.
 */
export interface RemoteDocRef {
  /** Owning provider id (`"lark"` / `"google"`). */
  providerId: string
  kind: RemoteDocKind
  /** Provider-stable identifier: Lark doc/wiki/app token, Google file id. */
  id: string
  /** Display title. Falls back to the id when the provider cannot cheaply resolve one. */
  title: string
  /** Canonical web URL, when the provider can build one. */
  url?: string
  /** Secondary picker line — owning space, folder, or breadcrumb. */
  sublabel?: string
  /** Last-modified time in ms since epoch, when known. */
  updatedAtMs?: number
}

/** A fetched body, ready to be staged as a composer attachment. */
export interface RemoteDocContent {
  ref: RemoteDocRef
  /** Resolved title — may be better than `ref.title` once the body was fetched. */
  title: string
  /** Plain text / markdown / CSV. Never HTML. */
  text: string
  format: RemoteDocFormat
  /**
   * True when the provider hit a row/table/char cap. The body ALSO carries a
   * visible truncation marker — this flag exists so the UI can warn, not so a
   * caller can silently ignore the loss.
   */
  truncated?: boolean
}

/**
 * Failure taxonomy. `code` + `params` slot directly into
 * `docsProviders.errors.<code>` so no provider ever formats user-facing copy.
 *
 * Mirrors `LarkIngestError` (`lib/twin/ingest/lark-doc-fetcher.ts`) — the Lark
 * provider maps that error's codes onto these one-to-one.
 */
export type DocsProviderErrorCode =
  | "notConfigured"
  | "notAuthorized"
  | "noPermission"
  | "notFound"
  | "unsupportedType"
  | "rateLimited"
  | "empty"
  | "hostUnsupported"
  | "network"
  | "invalidRef"

export class DocsProviderError extends Error {
  readonly code: DocsProviderErrorCode
  readonly params?: Record<string, string>

  constructor(code: DocsProviderErrorCode, params?: Record<string, string>) {
    super(params?.reason ? `${code}: ${params.reason}` : code)
    this.name = "DocsProviderError"
    this.code = code
    this.params = params
  }
}

/**
 * One connected identity a provider can act as.
 *
 * Lark returns one entry per enabled Lark connector instance (a user may bind
 * several tenants); Google returns at most one, because its connection is a
 * single OAuth client.
 */
export interface DocsProviderAccount {
  /** Provider-scoped account id — a Lark adapter id, or `"default"` for Google. */
  id: string
  /** User-visible label (adapter display name, Google account email). */
  label: string
}

/** Per-call options shared by `search` and `fetch`. */
export interface DocsProviderCallOptions {
  /** Which `DocsProviderAccount.id` to act as. */
  accountId: string
  signal?: AbortSignal
}

export interface DocsProviderSearchOptions extends DocsProviderCallOptions {
  limit: number
}

export interface DocsProvider {
  /** Stable id — also the settings card key and the i18n key segment. */
  readonly id: string
  /**
   * Composer namespace prefix WITHOUT the leading `@` and WITH the trailing
   * colon (`"lark:"`), matching `CHAT_NAMESPACE_PREFIXES` in
   * `components/chat/composer-trigger.ts`.
   */
  readonly mentionPrefix: string
  /** Reference kinds this provider can resolve. The picker never offers others. */
  readonly kinds: readonly RemoteDocKind[]
  /**
   * Hosts where this provider can actually run.
   *
   * INTENTIONAL DORMANCY (project rule 7, type axis): both built-in providers
   * are `["tauri"]`. Feishu's open APIs send no CORS headers so only the Rust
   * `connectors_http_request` bridge can reach them, and Google's installed-app
   * OAuth needs the Rust loopback callback listener. On every other host the
   * picker renders a `hostUnsupported` empty state rather than a broken list.
   */
  readonly hosts: readonly Platform[]

  /** Connected identities, newest-usable first. Empty ⇒ the provider is unconfigured. */
  listAccounts(): Promise<DocsProviderAccount[]>

  /**
   * Recognize a pasted URL or bare token. PURE — no network, no credentials,
   * so the composer can call it on every keystroke.
   */
  matchRef(input: string): Omit<RemoteDocRef, "providerId" | "title"> | null

  /**
   * Keyword search. Optional: a provider without a usable search API omits it
   * and the picker offers link-pasting only.
   */
  search?(query: string, opts: DocsProviderSearchOptions): Promise<RemoteDocRef[]>

  /** Fetch the body. Throws `DocsProviderError` on every failure path. */
  fetch(ref: RemoteDocRef, opts: DocsProviderCallOptions): Promise<RemoteDocContent>
}
