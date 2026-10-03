/**
 * In-frame shell for VS Code extension webviews.
 *
 * Loaded first in every scripted webview frame
 * (`lib/plugin/vscode-shim/webview-document.ts`). It is a FILE on the app's
 * origin, not an inline script, because the frame inherits the packaged app's
 * content security policy, which runs only same-origin and `blob:` scripts
 * (ADR-0158). It:
 *
 *   - provides `acquireVsCodeApi()` (postMessage, getState, setState);
 *   - runs the webview's scripts, which the host hands over in a `load`
 *     envelope, one at a time as in-frame `blob:` scripts with their original
 *     nonce, `document.currentScript.src` reading the file each came from;
 *     then dispatches `DOMContentLoaded` and `load` for code that waits on them;
 *   - delivers the extension's messages as `message` events, and keeps the
 *     host's own envelopes from reaching the page;
 *   - answers webview resource URIs set later (`src` / `href` on images,
 *     scripts, stylesheets and media, and `fetch`) with the file, read through
 *     the host;
 *   - sends link clicks to the host, which opens them (or runs `command:`
 *     links the webview allows);
 *   - follows the app's theme.
 *
 * Every envelope carries `__vscodeWebview`; only the parent's are accepted.
 */
;(function () {
  "use strict"

  var MARK = "__vscodeWebview"
  var RESOURCE_ORIGIN = "https://file+.vscode-resource.cognia.invalid"
  var host = window.parent
  var state
  var baseUrl
  var nextRequest = 1
  var pending = {}
  var blobUrls = {}

  function send(kind, fields) {
    var message = fields || {}
    message[MARK] = kind
    host.postMessage(message, "*")
  }

  // ── acquireVsCodeApi ──────────────────────────────────────────────────
  var acquired = false
  var api = Object.freeze({
    postMessage: function (message) {
      send("post", { data: message })
    },
    getState: function () {
      return state
    },
    setState: function (value) {
      state = value
      send("set-state", { state: value })
      return value
    },
  })
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error("An instance of the VS Code API has already been acquired")
    acquired = true
    return api
  }

  // ── Resources ─────────────────────────────────────────────────────────
  function isResource(url) {
    return typeof url === "string" && url.indexOf(RESOURCE_ORIGIN + "/") === 0
  }

  /** A URI the page set, as a resource URI when it names one; otherwise `null`. */
  function resourceOf(value) {
    if (typeof value !== "string" || value === "") return null
    if (isResource(value)) return value
    // A relative URI means a resource only under the webview's own `<base>`.
    if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.charAt(0) === "#") return null
    try {
      var resolved = new URL(value, baseUrl).href
      return isResource(resolved) ? resolved : null
    } catch (_error) {
      return null
    }
  }

  function decode(base64) {
    var binary = atob(base64)
    var bytes = new Uint8Array(binary.length)
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  function readResource(url) {
    return new Promise(function (resolve, reject) {
      var id = nextRequest
      nextRequest += 1
      pending[id] = { resolve: resolve, reject: reject }
      send("resource", { id: id, url: url.split("#")[0] })
    })
  }

  function blobUrlFor(url) {
    var key = url.split("#")[0]
    if (!blobUrls[key]) {
      blobUrls[key] = readResource(key).then(function (resource) {
        return URL.createObjectURL(new Blob([decode(resource.data)], { type: resource.mime }))
      })
    }
    return blobUrls[key]
  }

  var originalFetch = window.fetch
  window.fetch = function (input) {
    var url =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : String(input)
    var resource = resourceOf(url)
    if (!resource) return originalFetch.apply(this, arguments)
    return readResource(resource).then(function (result) {
      return new Response(decode(result.data), {
        status: 200,
        headers: { "Content-Type": result.mime },
      })
    })
  }

  /** Route a resource URI set on an element through the host, then set the file's blob URL. */
  function deferred(element, value, set, fallback) {
    var resource = resourceOf(value)
    if (!resource) return false
    blobUrlFor(resource).then(
      function (url) {
        set.call(element, url)
      },
      function () {
        // Let the element fail as it would on a missing file.
        fallback.call(element, resource)
      }
    )
    return true
  }

  function hookProperty(proto, property) {
    var descriptor = proto && Object.getOwnPropertyDescriptor(proto, property)
    if (!descriptor || !descriptor.set) return
    Object.defineProperty(proto, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) {
        if (!deferred(this, value, descriptor.set, descriptor.set)) descriptor.set.call(this, value)
      },
    })
  }
  hookProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, "src")
  hookProperty(window.HTMLImageElement && HTMLImageElement.prototype, "src")
  hookProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, "href")
  hookProperty(window.HTMLSourceElement && HTMLSourceElement.prototype, "src")
  hookProperty(window.HTMLMediaElement && HTMLMediaElement.prototype, "src")
  hookProperty(window.HTMLVideoElement && HTMLVideoElement.prototype, "poster")

  var URL_ATTRIBUTES = { src: true, href: true, poster: true }
  var originalSetAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    var attribute = String(name).toLowerCase()
    var loads =
      this instanceof HTMLScriptElement ||
      this instanceof HTMLImageElement ||
      this instanceof HTMLLinkElement ||
      this instanceof HTMLSourceElement ||
      this instanceof HTMLMediaElement
    if (URL_ATTRIBUTES[attribute] && loads) {
      var set = function (url) {
        originalSetAttribute.call(this, name, url)
      }
      if (deferred(this, value, set, set)) return
    }
    return originalSetAttribute.apply(this, arguments)
  }

  // ── Scripts ───────────────────────────────────────────────────────────
  var currentScriptDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "currentScript")

  /** For the script now running, `document.currentScript` reports the file it came from. */
  function pretendCurrentScript(url) {
    var stand = document.createElement("script")
    // Through the original setter: this element is never inserted, so never loads.
    originalSetAttribute.call(stand, "src", url)
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      get: function () {
        return stand
      },
    })
  }

  function restoreCurrentScript() {
    if (currentScriptDescriptor) delete document.currentScript
  }

  function runScripts(scripts, index, done) {
    if (index >= scripts.length) {
      done()
      return
    }
    var script = scripts[index]
    var element = document.createElement("script")
    if (script.nonce) originalSetAttribute.call(element, "nonce", script.nonce)
    if (script.module) element.type = "module"
    var source = script.code + (script.url ? "\n//# sourceURL=" + script.url : "")
    var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
    if (script.url) pretendCurrentScript(script.url)
    var finished = false
    var next = function () {
      if (finished) return
      finished = true
      if (script.url) restoreCurrentScript()
      URL.revokeObjectURL(url)
      runScripts(scripts, index + 1, done)
    }
    element.addEventListener("load", next)
    element.addEventListener("error", next)
    originalSetAttribute.call(element, "src", url)
    ;(document.body || document.documentElement).appendChild(element)
  }

  function loaded() {
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }))
    window.dispatchEvent(new Event("load"))
    send("loaded")
  }

  // ── Theme ─────────────────────────────────────────────────────────────
  function applyTheme(css, kind) {
    var style = document.getElementById("_vscodeThemeVariables")
    if (style && typeof css === "string") style.textContent = css
    if (document.body && (kind === "vscode-light" || kind === "vscode-dark")) {
      document.body.classList.remove("vscode-light", "vscode-dark")
      document.body.classList.add(kind)
      document.body.setAttribute("data-vscode-theme-kind", kind)
    }
  }

  // ── Links ─────────────────────────────────────────────────────────────
  function onClick(event) {
    if (event.defaultPrevented || (event.type === "auxclick" && event.button !== 1)) return
    var target = event.target
    var anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null
    if (!anchor) return
    var href = anchor.getAttribute("href") || ""
    if (href === "" || href.charAt(0) === "#") return
    event.preventDefault()
    var resolved = href
    try {
      resolved = new URL(href, baseUrl || RESOURCE_ORIGIN + "/").href
    } catch (_error) {
      // Not a URL: hand it over as written.
    }
    send("link", { href: /^command:/i.test(href) ? href : resolved })
  }
  document.addEventListener("click", onClick)
  document.addEventListener("auxclick", onClick)

  // ── Host envelopes ────────────────────────────────────────────────────
  window.addEventListener(
    "message",
    function (event) {
      if (event.source !== host) return
      var data = event.data
      if (!data || typeof data !== "object" || !(MARK in data)) return
      // The page sees only the extension's messages, never the host's envelopes.
      event.stopImmediatePropagation()
      switch (data[MARK]) {
        case "load":
          state = data.state
          baseUrl = typeof data.baseUrl === "string" ? data.baseUrl : undefined
          runScripts(Array.isArray(data.scripts) ? data.scripts : [], 0, loaded)
          break
        case "message":
          window.dispatchEvent(new MessageEvent("message", { data: data.data }))
          break
        case "resource": {
          var request = pending[data.id]
          if (!request) break
          delete pending[data.id]
          if (data.ok) request.resolve({ data: data.data, mime: data.mime })
          else request.reject(new Error(data.error || "resource unavailable"))
          break
        }
        case "theme":
          applyTheme(data.css, data.kind)
          break
      }
    },
    true
  )

  send("ready")
})()
