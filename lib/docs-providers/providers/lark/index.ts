/**
 * Feishu/Lark remote document provider (ADR-0134).
 *
 * Credentials are NOT its own: it acts as a bound Lark connector instance, so
 * a user who has already connected Feishu for IM gets document reading with
 * zero extra setup, and document ACLs are evaluated against the OAuth user
 * they connected. `listAccounts` is therefore a projection of the enabled
 * Lark adapter rows — the same list `components/twin/lark-account-picker.tsx`
 * shows.
 *
 * Document bodies come straight from `fetchLarkDocAsRawSource`; only the two
 * grid-shaped kinds (电子表格 / 多维表格) needed new readers, and those run on
 * the shared `withLarkAuthedApi` harness that the doc fetcher itself now uses.
 */

import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { withLarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { LarkConnectedUser } from "@/lib/connectors/adapters/lark/oauth-handler"
import { fetchLarkDocAsRawSource } from "@/lib/twin/ingest/lark-doc-fetcher"
import { parseLarkResourceUrl } from "@/lib/twin/ingest/lark-url"
import { clampDocText } from "@/lib/docs-providers/limits"
import {
  DocsProviderError,
  type DocsProvider,
  type DocsProviderAccount,
  type DocsProviderCallOptions,
  type DocsProviderSearchOptions,
  type RemoteDocContent,
  type RemoteDocKind,
  type RemoteDocRef,
} from "@/lib/docs-providers/types"
import { readLarkBitable } from "./bitable"
import { toDocsProviderError } from "./errors"
import { searchLarkDocs } from "./search"
import { readLarkSpreadsheet } from "./sheets"

export const LARK_PROVIDER_ID = "lark"

/** `parseLarkResourceUrl` kinds → provider kinds. `docx` and `doc` both read as a document. */
const RESOURCE_KIND_TO_DOC_KIND: Record<string, RemoteDocKind> = {
  docx: "doc",
  doc: "doc",
  wiki: "wiki",
  sheet: "sheet",
  bitable: "bitable",
}

/**
 * The string `fetchLarkDocAsRawSource` parses. It takes a URL or a bare token,
 * so a search hit (token only, tenant host unknown) round-trips through the
 * bare-token branch of `parseLarkDocUrl`.
 */
function docInputFor(ref: RemoteDocRef): string {
  return ref.url ?? ref.id
}

export const larkDocsProvider: DocsProvider = {
  id: LARK_PROVIDER_ID,
  mentionPrefix: "lark:",
  kinds: ["doc", "wiki", "sheet", "bitable"],
  // Feishu's open APIs send no CORS headers, so only the Rust
  // `connectors_http_request` bridge can reach them. See `DocsProvider.hosts`.
  hosts: ["tauri"],

  async listAccounts(): Promise<DocsProviderAccount[]> {
    const rows = await listAdapterInstancesByType(LARK_PROVIDER_ID)
    return rows
      .filter((row) => row.enabled)
      .map((row) => {
        const connected = (row.settings as { connectedUser?: LarkConnectedUser }).connectedUser
        return {
          id: row.id,
          label: connected?.name ? `${row.displayName} · ${connected.name}` : row.displayName,
        }
      })
  },

  matchRef(input) {
    const ref = parseLarkResourceUrl(input)
    if (!ref) return null
    const kind = RESOURCE_KIND_TO_DOC_KIND[ref.kind]
    if (!kind) return null
    return {
      kind,
      id: ref.token,
      ...(ref.host ? { url: input.trim() } : {}),
    }
  },

  async search(query: string, opts: DocsProviderSearchOptions): Promise<RemoteDocRef[]> {
    try {
      return await withLarkAuthedApi(
        { adapterId: opts.accountId, requireUserIdentity: true },
        (api) => searchLarkDocs(api, query, opts.limit)
      )
    } catch (err) {
      throw toDocsProviderError(err)
    }
  },

  async fetch(ref: RemoteDocRef, opts: DocsProviderCallOptions): Promise<RemoteDocContent> {
    try {
      if (ref.kind === "doc" || ref.kind === "wiki") {
        const fetched = await fetchLarkDocAsRawSource(docInputFor(ref), {
          adapterId: opts.accountId,
        })
        const clamped = clampDocText(fetched.text)
        return {
          ref: { ...ref, title: fetched.title },
          title: fetched.title,
          text: clamped.text,
          format: "text",
          truncated: clamped.truncated,
        }
      }

      const read = await withLarkAuthedApi({ adapterId: opts.accountId }, (api) =>
        ref.kind === "sheet" ? readLarkSpreadsheet(api, ref.id) : readLarkBitable(api, ref.id)
      )
      if (!read.text.trim()) {
        throw new DocsProviderError("empty", { title: read.title })
      }
      const clamped = clampDocText(read.text)
      return {
        ref: { ...ref, title: read.title },
        title: read.title,
        text: clamped.text,
        format: "csv",
        truncated: read.truncated || clamped.truncated,
      }
    } catch (err) {
      throw toDocsProviderError(err)
    }
  },
}
