// Fixture server for the ADR-0239 WP10 submit-signal spike.
//
// Two origins (A = 127.0.0.1:PORT_A, B = localhost:PORT_B) so cross-origin
// cases are real. Every request a scenario makes carries `s=<id>` so the
// server log is the ground truth of "what left the page".

import http from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
/** Modules from the repository's pnpm store (`ws`, `playwright`); run from a checkout after `pnpm install`. */
export const repoRequire = createRequire(
  path.resolve(here, "../../../node_modules/.pnpm/node_modules/_")
)

const { WebSocketServer } = repoRequire("ws")

export const PORT_A = 4811
export const PORT_B = 4812
export const A = `http://127.0.0.1:${PORT_A}`
export const B = `http://localhost:${PORT_B}`

/** Every scenario: its page body and how the agent acts on it. */
export const SCENARIOS = {
  s1: {
    name: "form POST, click submit button",
    action: { kind: "click", target: "#t" },
    body: `<form method="post" action="/submit?s=s1"><input name="q" value="hello"><button id="t">Send</button></form>`,
  },
  s2: {
    name: "form GET (search), click submit button",
    action: { kind: "click", target: "#t" },
    body: `<form method="get" action="/search"><input type="hidden" name="s" value="s2"><input name="q" value="secret"><button id="t">Search</button></form>`,
  },
  s3: {
    name: "SPA: type=button + fetch POST",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="fetch('/api?s=s3',{method:'POST',body:'x'})">Save</button>`,
  },
  s4: {
    name: "div role=button + XHR POST",
    action: { kind: "click", target: "#t" },
    body: `<div role="button" id="t" onclick="var x=new XMLHttpRequest();x.open('POST','/api?s=s4');x.send('x')">Post</div>`,
  },
  s5: {
    name: "Enter in a form field (trusted key)",
    action: { kind: "press", target: "#t", key: "Enter" },
    body: `<form method="post" action="/submit?s=s5"><input id="t" name="q" value="hi"></form>`,
  },
  s6: {
    name: "Enter in a form field (synthetic KeyboardEvent)",
    action: { kind: "synthetic-key", target: "#t", key: "Enter" },
    body: `<form method="post" action="/submit?s=s6"><input id="t" name="q" value="hi"></form>`,
  },
  s7: {
    name: "submit button, synthetic MouseEvent click",
    action: { kind: "synthetic-click", target: "#t" },
    body: `<form method="post" action="/submit?s=s7"><input name="q" value="x"><button id="t">Send</button></form>`,
  },
  s8: {
    name: "button + navigator.sendBeacon",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="navigator.sendBeacon('/beacon?s=s8','payload')">Go</button>`,
  },
  s9: {
    name: "button + WebSocket send",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t">Chat</button><script>var ws=new WebSocket('ws://127.0.0.1:${PORT_A}/ws?s=s9');document.getElementById('t').onclick=function(){ws.send('hello s9')}</script>`,
  },
  s10: {
    name: "cross-origin fetch POST",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="fetch('${B}/api?s=s10',{method:'POST',body:'x'})">Send</button>`,
  },
  s11: {
    name: "contenteditable, Cmd/Ctrl+Enter sends (trusted)",
    action: { kind: "press", target: "#t", key: "ControlOrMeta+Enter" },
    body: `<div id="t" contenteditable="true">draft</div><script>document.getElementById('t').addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.metaKey||e.ctrlKey))fetch('/api?s=s11',{method:'POST',body:'x'})})</script>`,
  },
  s11b: {
    name: "contenteditable, Cmd/Ctrl+Enter sends (synthetic)",
    action: { kind: "synthetic-key", target: "#t", key: "Enter", meta: true },
    body: `<div id="t" contenteditable="true">draft</div><script>document.getElementById('t').addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.metaKey||e.ctrlKey))fetch('/api?s=s11b',{method:'POST',body:'x'})})</script>`,
  },
  s12: {
    name: "button + fetch GET carrying data",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="fetch('/api?s=s12&q=secret')">Lookup</button>`,
  },
  s13: {
    name: "in-page link with an analytics beacon",
    action: { kind: "click", target: "#t" },
    body: `<a href="#next" id="t" onclick="navigator.sendBeacon('/beacon?s=s13','analytics')">Next section</a>`,
  },
  s14: {
    name: "delayed form.submit() 1.5 s after the click",
    action: { kind: "click", target: "#t" },
    body: `<form id="f" method="post" action="/submit?s=s14"><input name="q" value="x"></form><button type="button" id="t" onclick="setTimeout(function(){document.getElementById('f').submit()},1500)">Later</button>`,
  },
  s15: {
    name: "button -> dedicated worker fetch POST",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t">Work</button><script>var w=new Worker(URL.createObjectURL(new Blob(["onmessage=function(){fetch('${A}/api?s=s15',{method:'POST',body:'x'})}"],{type:'text/javascript'})));document.getElementById('t').onclick=function(){w.postMessage(1)}</script>`,
  },
  s16: {
    name: "cross-origin iframe form POST",
    action: { kind: "click-frame", frame: "#fr", target: "#t" },
    body: `<iframe id="fr" src="${B}/frame?s=s16" width="300" height="100"></iframe>`,
  },
  s17: {
    name: "image pixel GET carrying data",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="new Image().src='/pixel?s=s17&d=secret'">Track</button>`,
  },
  s18: {
    name: "location.href navigation GET carrying data",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="location.href='/search?s=s18&q=secret'">Go</button>`,
  },
  s19: {
    name: "<a ping> link",
    action: { kind: "click", target: "#t" },
    body: `<a id="t" ping="/ping?s=s19" href="/landing?s=s19nav">Open</a>`,
  },
  s20: {
    name: "select auto-submits its form",
    action: { kind: "select", target: "#t", value: "b" },
    body: `<form id="f" method="post" action="/submit?s=s20"><select id="t" name="v" onchange="this.form.submit()"><option>a</option><option>b</option></select></form>`,
  },
  s21: {
    name: "fill a field that autosaves (input -> fetch POST)",
    action: { kind: "fill", target: "#t", value: "typed" },
    body: `<input id="t" oninput="fetch('/api?s=s21',{method:'POST',body:this.value})">`,
  },
  s22: {
    name: "plain button with no side effect",
    action: { kind: "click", target: "#t" },
    body: `<button type="button" id="t" onclick="document.body.dataset.n=1">Toggle</button>`,
  },
  s23: {
    name: "button type=submit outside any form",
    action: { kind: "click", target: "#t" },
    body: `<button type="submit" id="t">Orphan</button>`,
  },
}

export const BYPASSES = {
  b1: {
    name: "fetch taken from a fresh iframe",
    body: `<iframe id="i" srcdoc=""></iframe><button type="button" id="t" onclick="document.getElementById('i').contentWindow.fetch('${A}/api?s=b1',{method:'POST',body:'x'})">Go</button>`,
  },
  b2: {
    name: "form submitted with a fresh iframe's HTMLFormElement.prototype.submit",
    body: `<iframe id="i" srcdoc=""></iframe><form id="f" method="post" action="/submit?s=b2"><input name="q" value="x"></form><button type="button" id="t" onclick="document.getElementById('i').contentWindow.HTMLFormElement.prototype.submit.call(document.getElementById('f'))">Go</button>`,
  },
  b3: {
    name: "fetch saved by the page before a late injection",
    body: `<script>var savedFetch=window.fetch</script><button type="button" id="t" onclick="savedFetch('/api?s=b3',{method:'POST',body:'x'})">Go</button>`,
  },
  b5: {
    name: "fetch taken from an iframe created at the click",
    body: `<button type="button" id="t" onclick="var i=document.createElement('iframe');document.body.appendChild(i);i.contentWindow.fetch('${A}/api?s=b5',{method:'POST',body:'x'})">Go</button>`,
  },
  b4: {
    name: "submit event listener registered by the page that stops propagation",
    body: `<form id="f" method="post" action="/submit?s=b4"><input name="q" value="x"><button id="t">Send</button></form><script>window.addEventListener('submit',function(e){e.stopImmediatePropagation()},true)</script>`,
  },
}

function page(id, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title></head><body>${body}</body></html>`
}

export function startServers() {
  /** @type {{ at: number, origin: string, method: string, url: string, body: string, kind: string }[]} */
  const log = []
  const handler = (origin) => (req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const url = new URL(req.url, "http://x")
      const s = url.searchParams.get("s") ?? ""
      if (url.pathname === "/fixture" || url.pathname === "/bypass") {
        const table = url.pathname === "/fixture" ? SCENARIOS : BYPASSES
        res.writeHead(200, { "content-type": "text/html" })
        res.end(page(s, table[s]?.body ?? "missing"))
        return
      }
      if (url.pathname === "/frame") {
        res.writeHead(200, { "content-type": "text/html" })
        res.end(
          page(
            "frame",
            `<form method="post" action="/submit?s=${s}"><input name="q" value="x"><button id="t">Send</button></form>`
          )
        )
        return
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(404)
        res.end()
        return
      }
      log.push({ at: Date.now(), origin, method: req.method, url: req.url, body, kind: "http" })
      res.writeHead(200, {
        "content-type": url.pathname === "/pixel" ? "image/gif" : "text/html",
        "access-control-allow-origin": "*",
      })
      res.end(
        url.pathname === "/submit" || url.pathname === "/search" || url.pathname === "/landing"
          ? page("done", "done")
          : "ok"
      )
    })
  }
  const a = http.createServer(handler("A"))
  const b = http.createServer(handler("B"))
  const wss = new WebSocketServer({ server: a })
  wss.on("connection", (socket, req) => {
    socket.on("message", (data) => {
      log.push({
        at: Date.now(),
        origin: "A",
        method: "WS",
        url: req.url,
        body: String(data),
        kind: "ws",
      })
    })
  })
  return new Promise((resolve) => {
    a.listen(PORT_A, "127.0.0.1", () =>
      b.listen(PORT_B, "localhost", () =>
        resolve({
          log,
          close: () => {
            wss.close()
            a.close()
            b.close()
          },
        })
      )
    )
  })
}
