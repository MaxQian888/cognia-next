import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"

const webRoot = "/srv"
const companionPrefixes = [
  "/api/",
  "/ws/",
  "/internal/",
  "/operator/",
  "/connectors/",
  "/integrations/",
  "/ide/",
  "/a2a",
  "/healthz",
  "/livez",
  "/readyz",
  "/metrics",
  "/.well-known/agent-card.json",
]

function isCompanionPath(pathname) {
  return companionPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix))
}

function proxyRequest(req, res, target) {
  const client = target.protocol === "https:" ? https : http
  const upstream = client.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
      rejectUnauthorized: false,
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    }
  )
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
    res.end(`proxy error: ${error.message}`)
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head, target) {
  const client = target.protocol === "https:" ? https : http
  const upstream = client.request({
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: req.headers,
    rejectUnauthorized: false,
  })
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(response.headers)
      .flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]
      )
      .join("\r\n")
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers}\r\n\r\n`)
    if (head.length > 0) upstreamSocket.write(head)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  upstream.on("response", (response) => {
    socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`)
  })
  upstream.on("error", () => socket.destroy())
  upstream.end()
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
])

function staticFile(pathname) {
  const decoded = decodeURIComponent(pathname)
  const relative = decoded.replace(/^\/+/, "")
  const candidates = [relative, `${relative}.html`, path.join(relative, "index.html"), "index.html"]
  for (const candidate of candidates) {
    const resolved = path.resolve(webRoot, candidate)
    if (!resolved.startsWith(`${webRoot}${path.sep}`) && resolved !== webRoot) continue
    try {
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {}
  }
  return null
}

const server = https.createServer(
  {
    cert: fs.readFileSync("/cognia-data/cognia/companion/tls.pem"),
    key: fs.readFileSync("/cognia-data/cognia/companion/tls.key"),
  },
  (req, res) => {
    const pathname = new URL(req.url ?? "/", "https://cognia.localhost").pathname
    if (pathname.startsWith("/v2/signaling")) {
      proxyRequest(req, res, new URL("http://signaling:7892"))
      return
    }
    if (isCompanionPath(pathname)) {
      proxyRequest(req, res, new URL("https://cognia-server:27890"))
      return
    }
    const file = staticFile(pathname)
    if (!file) {
      res.writeHead(404)
      res.end()
      return
    }
    const cacheControl = pathname.startsWith("/_next/static/")
      ? "public, max-age=31536000, immutable"
      : pathname.endsWith(".html") || pathname === "/" || pathname === "/sw.js"
        ? "no-store"
        : "public, max-age=3600"
    res.writeHead(200, {
      "cache-control": cacheControl,
      "content-type": contentTypes.get(path.extname(file)) ?? "application/octet-stream",
    })
    fs.createReadStream(file).pipe(res)
  }
)

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "https://cognia.localhost").pathname
  if (pathname.startsWith("/v2/signaling")) {
    proxyUpgrade(req, socket, head, new URL("http://signaling:7892"))
    return
  }
  if (isCompanionPath(pathname)) {
    proxyUpgrade(req, socket, head, new URL("https://cognia-server:27890"))
    return
  }
  socket.destroy()
})

server.listen(443, "0.0.0.0")
