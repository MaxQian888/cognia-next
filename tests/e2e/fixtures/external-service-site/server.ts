import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { once } from "node:events"

const LOGIN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connector fixture</title></head>
<body data-readiness="fixture-v1">
  <main>
    <h1>Connector fixture</h1>
    <form method="post" action="/login">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body></html>`

const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture dashboard</title></head>
<body data-readiness="fixture-v1">
  <main>
    <h1>Dashboard</h1>
    <form method="post" action="/submit">
      <label>Title <input name="title" required></label>
      <button type="submit">Save</button>
    </form>
    <button id="load-dynamic" type="button">Load dynamic content</button>
    <section id="dynamic" aria-live="polite"></section>
    <iframe title="Embedded editor" src="/frame"></iframe>
    <form method="post" action="/upload" enctype="multipart/form-data">
      <label>Attachment <input name="attachment" type="file"></label>
      <button type="submit">Upload</button>
    </form>
    <a href="/download" download="fixture.txt">Download fixture</a>
  </main>
  <script>
    document.querySelector('#load-dynamic').addEventListener('click', async () => {
      const response = await fetch('/dynamic')
      document.querySelector('#dynamic').textContent = await response.text()
    })
  </script>
</body></html>`

const FRAME = `<!doctype html><html lang="en"><body>
  <label>Frame note <input name="frame-note"></label>
  <button type="button" onclick="document.body.dataset.saved='true'">Save frame</button>
</body></html>`

function send(response: ServerResponse, status: number, body: string, contentType = "text/html") {
  response.writeHead(status, { "content-type": `${contentType}; charset=utf-8` })
  response.end(body)
}

function route(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://fixture.local")
  if (request.method === "POST" && url.pathname === "/login") {
    response.writeHead(303, {
      location: "/dashboard",
      "set-cookie": "fixture_session=ok; HttpOnly",
    })
    response.end()
    return
  }
  if (request.method === "POST" && ["/submit", "/upload"].includes(url.pathname)) {
    request.resume()
    request.on("end", () => send(response, 200, "Saved", "text/plain"))
    return
  }
  if (url.pathname === "/") return send(response, 200, LOGIN)
  if (url.pathname === "/dashboard") return send(response, 200, DASHBOARD)
  if (url.pathname === "/frame") return send(response, 200, FRAME)
  if (url.pathname === "/dynamic") return send(response, 200, "Dynamic content ready", "text/plain")
  if (url.pathname === "/changed") {
    return send(
      response,
      200,
      "<!doctype html><html><body><h1>Redesigned dashboard</h1></body></html>"
    )
  }
  if (url.pathname === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": "attachment; filename=fixture.txt",
    })
    response.end("quarantine fixture")
    return
  }
  send(response, 404, "Not found", "text/plain")
}

export async function startExternalServiceFixture(): Promise<{
  server: Server
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer(route)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address")
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}
