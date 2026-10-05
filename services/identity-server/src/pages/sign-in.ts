/**
 * The login page the OAuth provider sends an unauthenticated authorize
 * request to (`loginPage: "/sign-in"`).
 *
 * The authorize request arrives as a signed query (`sig`, `exp`, …). Signing
 * in posts that query back as `oauth_query`, and Better Auth resumes the
 * authorization once the social callback sets a session.
 *
 * The apps pick the provider in their own UI and pass `provider=<id>` on the
 * authorize request, which Better Auth keeps in the signed query. When it
 * names a provider this deployment offers, the page goes straight to that
 * provider, so the person sees one screen of Cognia UI, not two.
 */

import { enabledProviders, type IdentityConfig, type ProviderId } from "../config"
import { GO_ICON, escapeHtml, htmlResponse, newNonce, renderDocument } from "./document"
import { localeFrom, t, type MessageKey } from "./strings"

const SCRIPT = `
const data = JSON.parse(document.getElementById("page-data").textContent);
const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-provider]"));
const oauthQuery = location.search.slice(1);
async function start(provider) {
  buttons.forEach((button) => { button.disabled = true; });
  status.textContent = data.redirecting[provider] || "";
  try {
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: "/sign-in", errorCallbackURL: "/error", oauth_query: oauthQuery }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body.url === "string") { location.assign(body.url); return; }
  } catch (error) {}
  status.textContent = data.failed;
  buttons.forEach((button) => { button.disabled = false; });
}
buttons.forEach((button) => button.addEventListener("click", () => start(button.dataset.provider)));
if (data.autoProvider) start(data.autoProvider);
`

function providerLabel(locale: ReturnType<typeof localeFrom>, id: ProviderId): string {
  return t(locale, `provider.${id}` as MessageKey)
}

export function signInPage(request: Request, config: Pick<IdentityConfig, "providers">): Response {
  const url = new URL(request.url)
  const locale = localeFrom(request.headers.get("accept-language"))
  const nonce = newNonce()
  const providers = enabledProviders(config)
  // Without a signed authorize request there is nothing to sign in *for*:
  // a session here alone gives the person nothing.
  const fromAuthorize = url.searchParams.has("sig")
  const requested = url.searchParams.get("provider")
  const autoProvider =
    fromAuthorize && requested && (providers as readonly string[]).includes(requested)
      ? requested
      : null

  let body = `<h1>${escapeHtml(t(locale, "signIn.title"))}</h1>`
  if (!fromAuthorize) {
    body += `<p>${escapeHtml(t(locale, "signIn.startFromApp"))}</p>`
  } else if (providers.length === 0) {
    body += `<p>${escapeHtml(t(locale, "signIn.noProviders"))}</p>`
  } else {
    body += `<p>${escapeHtml(t(locale, "signIn.choose"))}</p><div class="actions">`
    body += providers
      .map(
        (id) =>
          `<button type="button" class="provider" data-provider="${id}"${autoProvider ? " disabled" : ""}><span>${escapeHtml(
            t(locale, "signIn.continueWith", { provider: providerLabel(locale, id) })
          )}</span>${GO_ICON}</button>`
      )
      .join("")
    body += `</div>`
  }
  body += `<div id="status" class="status" role="status" aria-live="polite"></div>`

  const data = {
    autoProvider,
    failed: t(locale, "signIn.failed"),
    redirecting: Object.fromEntries(
      providers.map((id) => [
        id,
        t(locale, "signIn.redirecting", { provider: providerLabel(locale, id) }),
      ])
    ),
  }
  const html = renderDocument({
    locale,
    title: t(locale, "signIn.title"),
    nonce,
    // Going straight to a provider is a wait; choosing one is a welcome.
    icon: autoProvider ? "waiting" : "welcome",
    showcase: { heading: t(locale, "brand.tagline"), text: t(locale, "signIn.subtitle") },
    body,
    ...(fromAuthorize && providers.length > 0 ? { data, script: SCRIPT } : {}),
  })
  return htmlResponse(html, nonce)
}
