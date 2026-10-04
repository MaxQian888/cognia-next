/**
 * SPIKE: a browser stand-in for the Cognia app as a public PKCE client.
 * `/demo/client` starts authorization; `/demo/client/callback` exchanges the
 * code and shows the decoded tokens. Nothing here is part of the issuer.
 */
export function demoClientPage(clientId: string, resource: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cognia demo client (spike)</title>
<style>body{font:14px system-ui;max-width:760px;margin:40px auto}pre{background:#f5f5f5;padding:12px;white-space:pre-wrap;word-break:break-all}</style>
</head><body>
<h1>Cognia demo client</h1>
<button id="start">Sign in with Cognia</button>
<pre id="out"></pre>
<script>
const clientId = ${JSON.stringify(clientId)};
const resource = ${JSON.stringify(resource)};
const redirectUri = location.origin + "/demo/client/callback";
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const decode = (jwt) => JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
async function start() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));
  const url = new URL("/api/auth/oauth2/authorize", location.origin);
  Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: "openid profile offline_access sync", state, code_challenge: challenge,
    code_challenge_method: "S256", resource }).forEach(([k, v]) => url.searchParams.set(k, v));
  location.href = url;
}
async function finish() {
  const params = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem("pkce") || "{}");
  if (params.get("error")) { out.textContent = "error: " + params.get("error") + " " + params.get("error_description"); return; }
  if (params.get("state") !== saved.state) { out.textContent = "state mismatch"; return; }
  const response = await fetch("/api/auth/oauth2/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      code: params.get("code"), redirect_uri: redirectUri, code_verifier: saved.verifier, resource }) });
  const tokens = await response.json();
  window.__spikeTokens = tokens;
  out.textContent = JSON.stringify({ status: response.status, scope: tokens.scope,
    access_token_claims: tokens.access_token ? decode(tokens.access_token) : tokens,
    id_token_claims: tokens.id_token ? decode(tokens.id_token) : null,
    has_refresh_token: Boolean(tokens.refresh_token) }, null, 2);
}
const out = document.getElementById("out");
document.getElementById("start").addEventListener("click", start);
if (location.pathname.endsWith("/callback")) finish();
</script></body></html>`
}
