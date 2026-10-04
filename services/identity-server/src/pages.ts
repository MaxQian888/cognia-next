/**
 * The minimal login page the OAuth provider redirects to. The authorize
 * request arrives as a signed query (`sig`, `exp`, …) which is passed back as
 * `oauth_query` on sign-in so the provider resumes the authorization.
 */
export function signInPage(feishu: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cognia sign-in (spike)</title>
<style>body{font:15px system-ui;max-width:360px;margin:64px auto}input,button{display:block;width:100%;margin:8px 0;padding:8px}</style>
</head><body>
<h1>Cognia</h1>
${feishu ? '<button id="feishu">Sign in with Feishu</button><hr>' : ""}
<form id="email"><input name="email" type="email" placeholder="email" required>
<input name="password" type="password" placeholder="password" required>
<button>Sign in</button></form>
<pre id="out"></pre>
<script>
const oauthQuery = location.search.slice(1);
async function post(path, body) {
  const response = await fetch("/api/auth" + path, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, oauth_query: oauthQuery }),
  });
  const json = await response.json().catch(() => ({}));
  if (json.url) { location.href = json.url; return; }
  document.getElementById("out").textContent = JSON.stringify(json, null, 2);
}
document.getElementById("email").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  post("/sign-in/email", { email: form.get("email"), password: form.get("password") });
});
const feishu = document.getElementById("feishu");
if (feishu) feishu.addEventListener("click", () => post("/sign-in/social", { provider: "feishu", callbackURL: "/sign-in" }));
</script></body></html>`
}
