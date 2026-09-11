/**
 * Runtime-free offline eval harness for cognia-web-tools.
 *
 * `pnpm plugin:eval` cannot load the real plugin entry (`src/index.ts` imports
 * the Next app — `@/lib/...`, Zustand stores), so this harness provides a
 * deterministic, network-free stand-in for each tool. Its job is to verify the
 * tool CONTRACT (input → output shape) in CI; model tool-SELECTION is verified
 * separately by the `--online` cases run inside the app.
 *
 * Keep the output shape in lockstep with `src/index.ts`:
 *   - `web_download` → `{ ok, path, bytes, contentType?, savedTo }` with the
 *     same filename-basename / directory-validation rules as the source.
 *   - `web_research` → `{ ok, channel, object: { summary, sources }, text,
 *     parseError, fetched }` or `{ ok: false, error }`.
 */

const DOWNLOAD_FIXTURES = {
  "https://example.com/report.pdf": 2048,
  "https://example.com/a.zip": 4096,
  "https://evil.test/x": 64,
  "https://example.com/f.bin": 16,
}

const RESEARCH_FIXTURES = {
  "https://example.com":
    "Example Domain\n\nThis domain is for use in illustrative examples in documents.",
}

/** Mirror of `sanitizeFilename` in src/index.ts — basename + control strip. */
function sanitizeFilename(name) {
  const base = String(name).split(/[/\\]/).filter(Boolean).pop() ?? ""
  const clean = base.replace(/[\x00-\x1f\x7f]/g, "").trim()
  return clean === "" || clean === "." || clean === ".." ? "download.bin" : clean
}

/** Mirror of `sanitizeSubdir` — clean relative subfolders only. */
function sanitizeSubdir(raw) {
  const trimmed = String(raw).trim()
  if (!trimmed) return { ok: false, error: "directory is empty" }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, error: "directory must be relative" }
  }
  const parts = trimmed.split("/").map((p) => p.trim())
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) {
    return { ok: false, error: `directory "${raw}" is not a clean relative path` }
  }
  return { ok: true, dir: parts.join("/") }
}

function basenameFromUrl(url) {
  try {
    const u = new URL(url)
    return u.pathname.split("/").filter(Boolean).pop() ?? "download.bin"
  } catch {
    return "download.bin"
  }
}

/**
 * @param {string} name tool name as declared in the manifest
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
export async function invokeTool(name, args) {
  if (name === "web_download") {
    const url = String(args.url ?? "")
    if (!url) return { ok: false, error: "url is required" }
    const filename = sanitizeFilename(args.filename ?? basenameFromUrl(url))
    let dir = ""
    if (args.directory) {
      const scoped = sanitizeSubdir(args.directory)
      if (!scoped.ok) return { ok: false, error: scoped.error }
      dir = scoped.dir
    }
    const bytes = DOWNLOAD_FIXTURES[url]
    if (bytes === undefined) return { ok: false, error: `HTTP 404` }
    return {
      ok: true,
      path: dir ? `${dir}/${filename}` : filename,
      bytes,
      savedTo: "plugin-data-dir",
    }
  }

  if (name === "web_research") {
    const query = typeof args.query === "string" ? args.query.trim() : ""
    if (!query) return { ok: false, error: "query is required" }
    const urls = Array.isArray(args.urls) ? args.urls.filter((u) => typeof u === "string") : []
    const fetched = urls.filter((u) => RESEARCH_FIXTURES[u] !== undefined)
    const failed = urls
      .filter((u) => RESEARCH_FIXTURES[u] === undefined)
      .map((u) => ({ url: u, error: "HTTP 404" }))
    return {
      ok: true,
      channel: "text",
      toolsAvailable: false,
      object: {
        summary: `Deterministic fixture summary for "${query}".`,
        sources: fetched.map((u) => ({ url: u, title: u })),
      },
      text: `Deterministic fixture summary for "${query}".`,
      parseError: null,
      fetched,
      ...(failed.length > 0 ? { failed } : {}),
    }
  }

  throw new Error(`unknown tool: ${name}`)
}
