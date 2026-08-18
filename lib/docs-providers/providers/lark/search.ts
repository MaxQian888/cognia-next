/**
 * Feishu cloud-doc search.
 *
 * `POST /open-apis/suite/docs-api/search/object` is the only full-text search
 * across a user's 云文档. It accepts a `user_access_token` ONLY — the tenant
 * (bot) identity is rejected — so the call sets `requireUserIdentity` and the
 * caller surfaces `notAuthorized` when the account has no OAuth connection,
 * rather than letting the harness produce a confusing bot-permission error.
 *
 * Scope required on the Feishu app: one of `drive:drive`,
 * `drive:drive:readonly`, or `search:docs:read`.
 */

import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { RemoteDocKind, RemoteDocRef } from "@/lib/docs-providers/types"

export const LARK_DOC_SEARCH_PATH = "/open-apis/suite/docs-api/search/object"

/** Feishu's `docs_type` values we can actually read, mapped to our kinds. */
const DOCS_TYPE_TO_KIND: Record<string, RemoteDocKind> = {
  doc: "doc",
  docx: "doc",
  sheet: "sheet",
  bitable: "bitable",
}

/**
 * Types we ask Feishu for. `slides` and `mindnote` are omitted deliberately:
 * they have no public read API, so listing them would offer the user something
 * that always fails at fetch time.
 */
export const LARK_SEARCH_DOCS_TYPES = ["doc", "sheet", "bitable"] as const

interface SearchResponse {
  docs_entities?: {
    docs_token?: string
    docs_type?: string
    title?: string
    owner_id?: string
  }[]
  has_more?: boolean
  total?: number
}

/** Feishu caps `count` at 50 and `offset + count` at 200. */
export const LARK_SEARCH_MAX_COUNT = 50

export async function searchLarkDocs(
  api: LarkAuthedApi,
  query: string,
  limit: number
): Promise<RemoteDocRef[]> {
  const response = await api.post<SearchResponse>(LARK_DOC_SEARCH_PATH, {
    search_key: query,
    count: Math.min(Math.max(1, limit), LARK_SEARCH_MAX_COUNT),
    docs_types: [...LARK_SEARCH_DOCS_TYPES],
  })
  const out: RemoteDocRef[] = []
  for (const entity of response.docs_entities ?? []) {
    const kind = entity.docs_type ? DOCS_TYPE_TO_KIND[entity.docs_type] : undefined
    if (!kind || !entity.docs_token) continue
    out.push({
      providerId: "lark",
      kind,
      id: entity.docs_token,
      title: entity.title?.trim() || entity.docs_token,
    })
  }
  return out
}
