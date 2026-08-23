const MESSAGE_VERSION = 1

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function safeOrigin(value: string, baseHref: string = window.location.href): string | undefined {
  try {
    const url = new URL(value, baseHref)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

interface EmbedGrant {
  sessionToken: string
}

function isEmbedGrant(value: unknown): value is EmbedGrant {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionToken?: unknown }).sessionToken === "string" &&
    (value as { sessionToken: string }).sessionToken.length > 0
  )
}

class CogniaWorkflowApp extends HTMLElement {
  static observedAttributes = ["app", "api-base", "portal-url"]

  private _oidcToken?: string
  private iframe?: HTMLIFrameElement
  private portalOrigin?: string
  private onMessage?: (event: MessageEvent) => void
  private controller?: AbortController

  get oidcToken(): string | undefined {
    return this._oidcToken
  }

  set oidcToken(value: string | undefined) {
    this._oidcToken = typeof value === "string" ? value : undefined
    if (this.isConnected) this.render()
  }

  connectedCallback(): void {
    this.render()
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.render()
  }

  disconnectedCallback(): void {
    if (this.onMessage) window.removeEventListener("message", this.onMessage)
    this.controller?.abort()
  }

  private invalidConfig(): void {
    this.dispatchEvent(new CustomEvent("cognia-error", { detail: { code: "invalid_config" } }))
  }

  private render(): void {
    if (this.onMessage) window.removeEventListener("message", this.onMessage)
    this.controller?.abort()
    this.replaceChildren()

    const app = this.getAttribute("app")?.trim()
    const apiBase = safeOrigin(this.getAttribute("api-base") || window.location.origin)
    let portalUrl: URL
    try {
      portalUrl = new URL(this.getAttribute("portal-url") || "/portal", window.location.href)
    } catch {
      this.invalidConfig()
      return
    }
    if (!app || !apiBase || !safeOrigin(portalUrl.href)) {
      this.invalidConfig()
      return
    }

    portalUrl.searchParams.set("app", app)
    portalUrl.searchParams.set("api", apiBase)
    portalUrl.searchParams.set("embed", "1")
    const portalOrigin = portalUrl.origin
    const iframe = document.createElement("iframe")
    iframe.src = portalUrl.href
    iframe.title = this.getAttribute("title") || "Cognia Workflow App"
    iframe.referrerPolicy = "no-referrer"
    iframe.sandbox.add("allow-forms", "allow-scripts", "allow-same-origin", "allow-downloads")
    iframe.style.cssText = "display:block;width:100%;min-height:480px;border:0"
    this.append(iframe)
    this.iframe = iframe
    this.portalOrigin = portalOrigin
    this.onMessage = (event: MessageEvent) => {
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== this.portalOrigin ||
        !event.data ||
        typeof event.data !== "object" ||
        (event.data as { version?: unknown }).version !== MESSAGE_VERSION
      ) {
        return
      }
      if ((event.data as { type?: unknown }).type === "cognia.workflow-app.ready") {
        this.dispatchEvent(new CustomEvent("cognia-ready", { detail: event.data }))
      }
    }
    window.addEventListener("message", this.onMessage)

    this.controller = new AbortController()
    const headers: Record<string, string> = {}
    const oidcToken = this.oidcToken?.trim()
    if (oidcToken) headers.Authorization = `Bearer ${oidcToken}`
    void Promise.all([
      fetch(`${apiBase}/api/apps/${encodeURIComponent(app)}/embed-token`, {
        headers,
        credentials: "omit",
        signal: this.controller.signal,
      }).then(async (response): Promise<EmbedGrant> => {
        if (!response.ok) throw new Error(`embed_token_${response.status}`)
        const grant: unknown = await response.json()
        if (!isEmbedGrant(grant)) throw new Error("embed_token_invalid_response")
        return grant
      }),
      new Promise<void>((resolve) => iframe.addEventListener("load", () => resolve(), { once: true })),
    ])
      .then(([grant]) => {
        iframe.contentWindow?.postMessage(
          {
            type: "cognia.workflow-app.init",
            version: MESSAGE_VERSION,
            parentOrigin: window.location.origin,
            sessionToken: grant.sessionToken,
          },
          portalOrigin
        )
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          this.dispatchEvent(
            new CustomEvent("cognia-error", { detail: { code: "bootstrap_failed" } })
          )
        }
      })
  }
}

if (!customElements.get("cognia-workflow-app")) {
  customElements.define("cognia-workflow-app", CogniaWorkflowApp)
}
