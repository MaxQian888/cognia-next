/**
 * Google Workspace remote document provider (ADR-0134).
 *
 * Owns its own OAuth connection, separate from the Drive *backup* destination:
 * that one holds the minimal `drive.file` scope and can only see files this app
 * created, which is precisely the wrong shape for reading a document the user
 * already has. See `./config` for why the two are not merged.
 *
 * Desktop-only for a concrete reason, not a policy one: Google's installed-app
 * flow permits only a loopback redirect, and the loopback listener is the Rust
 * connectors server (`/oauth/docs/google/callback`).
 */

import { clampDocText } from "@/lib/docs-providers/limits"
import {
  DocsProviderError,
  type DocsProvider,
  type DocsProviderAccount,
  type DocsProviderCallOptions,
  type DocsProviderSearchOptions,
  type RemoteDocContent,
  type RemoteDocRef,
} from "@/lib/docs-providers/types"
import { registerDocsOAuthCompletion } from "@/lib/docs-providers/oauth-deep-link"
import { completeGoogleDocsAuth, getGoogleAccessToken } from "./auth"
import { getGoogleDocsSettings } from "./config"
import { googleHttp, type GoogleHttpFn } from "./http"
import { parseGoogleDocUrl, googleDocUrl } from "./url"
import {
  exportGoogleDoc,
  getGoogleFileName,
  readGoogleSpreadsheet,
  searchGoogleDocs,
  type GoogleApiContext,
} from "./api"

export const GOOGLE_PROVIDER_ID = "google"

/** Single account: the connection is one OAuth client, so the id is fixed. */
export const GOOGLE_ACCOUNT_ID = "default"

export interface GoogleProviderDeps {
  http?: GoogleHttpFn
  accessToken?: () => Promise<string>
}

let deps: GoogleProviderDeps = {}

/** Test seam — inject the transport and token resolver. */
export function __setGoogleProviderDepsForTests(next: GoogleProviderDeps): void {
  deps = next
}

async function context(signal?: AbortSignal): Promise<GoogleApiContext> {
  const accessToken = await (deps.accessToken ?? getGoogleAccessToken)()
  return { http: deps.http ?? googleHttp, accessToken, signal }
}

export const googleDocsProvider: DocsProvider = {
  id: GOOGLE_PROVIDER_ID,
  mentionPrefix: "gdoc:",
  // No Bitable counterpart exists in Google Workspace, and Slides has no useful
  // text read, so the picker never offers either for this provider.
  kinds: ["doc", "sheet"],
  // Google's APIs are CORS-friendly, but its installed-app OAuth redirect must
  // land on the Rust loopback listener. See `DocsProvider.hosts`.
  hosts: ["tauri"],

  async listAccounts(): Promise<DocsProviderAccount[]> {
    const settings = await getGoogleDocsSettings()
    if (!settings.connected) return []
    return [{ id: GOOGLE_ACCOUNT_ID, label: settings.accountEmail ?? "Google" }]
  },

  matchRef(input) {
    const ref = parseGoogleDocUrl(input)
    if (!ref) return null
    return { kind: ref.kind, id: ref.id, url: googleDocUrl(ref.kind, ref.id) }
  },

  async search(query: string, opts: DocsProviderSearchOptions): Promise<RemoteDocRef[]> {
    return searchGoogleDocs(await context(opts.signal), query, opts.limit)
  },

  async fetch(ref: RemoteDocRef, opts: DocsProviderCallOptions): Promise<RemoteDocContent> {
    const ctx = await context(opts.signal)
    if (ref.kind === "doc") {
      const [read, name] = await Promise.all([
        exportGoogleDoc(ctx, ref.id),
        // A ref from a pasted URL carries the id as its title; ask Drive for
        // the real name so the attachment is not called `1AbC_dEf…`.
        ref.title === ref.id ? getGoogleFileName(ctx, ref.id) : Promise.resolve(ref.title),
      ])
      if (!read.text.trim()) throw new DocsProviderError("empty", { title: name })
      const clamped = clampDocText(read.text)
      return {
        ref: { ...ref, title: name },
        title: name,
        text: clamped.text,
        format: read.format,
        truncated: clamped.truncated,
      }
    }

    if (ref.kind !== "sheet") {
      throw new DocsProviderError("unsupportedType", { type: ref.kind })
    }
    const read = await readGoogleSpreadsheet(ctx, ref.id)
    if (!read.text.trim()) throw new DocsProviderError("empty", { title: read.title })
    const clamped = clampDocText(read.text)
    return {
      ref: { ...ref, title: read.title },
      title: read.title,
      text: clamped.text,
      format: "csv",
      truncated: read.truncated || clamped.truncated,
    }
  },
}

// Registered at module load, next to the provider it completes, so the deep-link
// router never has to know which providers exist.
registerDocsOAuthCompletion(GOOGLE_PROVIDER_ID, async (callback) => {
  await completeGoogleDocsAuth({
    code: callback.code,
    state: callback.state,
    error: callback.error,
    errorDescription: callback.errorDescription,
  })
})
