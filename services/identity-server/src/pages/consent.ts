/**
 * The consent page (`consentPage: "/consent"`).
 *
 * The first-party clients skip consent, so this is reached only when a client
 * asks for it with `prompt=consent`. It names the client and the scopes it
 * asked for, and posts the person's decision with the signed query.
 */

import { escapeHtml, htmlResponse, newNonce, renderDocument } from "./document"
import { localeFrom, t, type MessageKey } from "./strings"

const KNOWN_SCOPES = new Set(["openid", "profile", "email", "offline_access"])

const SCRIPT = `
const data = JSON.parse(document.getElementById("page-data").textContent);
const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-accept]"));
async function decide(accept) {
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
    });
    const body = await response.json().catch(() => ({}));
    const next = body.redirect_uri || body.url;
    if (response.ok && typeof next === "string") { location.assign(next); return; }
  } catch (error) {}
  status.textContent = data.failed;
  buttons.forEach((button) => { button.disabled = false; });
}
buttons.forEach((button) => button.addEventListener("click", () => decide(button.dataset.accept === "true")));
`

export async function consentPage(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url)
  const locale = localeFrom(request.headers.get("accept-language"))
  const nonce = newNonce()
  const clientId = url.searchParams.get("client_id") ?? ""
  const client = clientId
    ? await db
        .prepare(
          'SELECT "name" FROM "oauthClient" WHERE "clientId" = ? AND ("disabled" IS NULL OR "disabled" = 0)'
        )
        .bind(clientId)
        .first<{ name: string | null }>()
    : null
  if (!url.searchParams.has("sig") || !client) {
    const html = renderDocument({
      locale,
      title: t(locale, "error.title"),
      nonce,
      mascot: "worried",
      body: `<h1>${escapeHtml(t(locale, "error.title"))}</h1><p>${escapeHtml(t(locale, "error.expired"))}</p>`,
    })
    return htmlResponse(html, nonce, 400)
  }
  const scopes = (url.searchParams.get("scope") ?? "")
    .split(" ")
    .filter((scope) => KNOWN_SCOPES.has(scope))
  const name = client.name || clientId
  const body = `<h1>${escapeHtml(t(locale, "consent.title", { client: name }))}</h1>
<p>${escapeHtml(t(locale, "consent.scopes"))}</p>
<ul>${scopes.map((scope) => `<li>${escapeHtml(t(locale, `scope.${scope}` as MessageKey))}</li>`).join("")}</ul>
<div class="actions"><button type="button" class="primary" data-accept="true">${escapeHtml(t(locale, "consent.allow"))}</button>
<button type="button" data-accept="false">${escapeHtml(t(locale, "consent.deny"))}</button></div>
<div id="status" class="status" role="status" aria-live="polite"></div>`
  const html = renderDocument({
    locale,
    title: t(locale, "consent.title", { client: name }),
    nonce,
    mascot: "welcome",
    body,
    data: { failed: t(locale, "consent.failed") },
    script: SCRIPT,
  })
  return htmlResponse(html, nonce)
}
