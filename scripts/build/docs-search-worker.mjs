// Pages serves precompressed assets before applying _headers, which can leave
// the browser with an extra gzip layer. Set encoding on the response itself.
const docsSearchWorker = {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== "/api/search" && url.pathname !== "/api/search/") {
      return env.ASSETS.fetch(request)
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })
    }

    url.pathname = "/api/search-index.json.gz"
    url.search = ""
    const asset = await env.ASSETS.fetch(new Request(url))
    if (!asset.ok) return asset

    return new Response(request.method === "HEAD" ? null : asset.body, {
      encodeBody: "manual",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Cache-Control": "public, max-age=0, must-revalidate, no-transform",
      },
    })
  },
}

export default docsSearchWorker
