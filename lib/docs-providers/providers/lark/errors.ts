/**
 * Feishu error → `DocsProviderError` translation.
 *
 * Reuses `mapLarkError` from the twin ingest fetcher rather than restating the
 * Lark business-code tables (`LARK_FORBIDDEN_CODES` &co.): one code table, two
 * consumers. The only thing added here is the last hop from the ingest
 * taxonomy to the provider taxonomy.
 */

import { LarkAccessError } from "@/lib/connectors/adapters/lark/authed-api"
import {
  LarkIngestError,
  mapLarkError,
  type LarkIngestErrorCode,
} from "@/lib/twin/ingest/lark-doc-fetcher"
import { DocsProviderError, type DocsProviderErrorCode } from "@/lib/docs-providers/types"

const INGEST_TO_PROVIDER: Record<LarkIngestErrorCode, DocsProviderErrorCode> = {
  larkInvalidUrl: "invalidRef",
  larkNoAccount: "notConfigured",
  larkNotAuthorized: "notAuthorized",
  larkNoPermission: "noPermission",
  larkNotFound: "notFound",
  larkUnsupportedType: "unsupportedType",
  larkRateLimited: "rateLimited",
  larkEmptyDoc: "empty",
  larkBrowserUnsupported: "hostUnsupported",
  // The provider never uses the lark-cli channel; if one ever leaks through,
  // "the tool you rely on is missing" is a configuration problem, not a network one.
  larkCliUnavailable: "notConfigured",
  larkNetwork: "network",
}

const ACCESS_TO_PROVIDER: Record<LarkAccessError["code"], DocsProviderErrorCode> = {
  browserUnsupported: "hostUnsupported",
  noAccount: "notConfigured",
  notAuthorized: "notAuthorized",
}

/**
 * Normalize anything thrown on a Lark read into a `DocsProviderError`.
 * `account` labels the failure with the bound Feishu account when known.
 */
export function toDocsProviderError(err: unknown, account?: string): DocsProviderError {
  if (err instanceof DocsProviderError) return err
  if (err instanceof LarkAccessError) {
    return new DocsProviderError(
      ACCESS_TO_PROVIDER[err.code],
      (err.account ?? account) ? { account: err.account ?? account ?? "" } : undefined
    )
  }
  const ingest = err instanceof LarkIngestError ? err : mapLarkError(err, account)
  return new DocsProviderError(INGEST_TO_PROVIDER[ingest.code], ingest.params)
}
