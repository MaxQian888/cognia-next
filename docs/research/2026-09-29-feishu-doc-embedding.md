# Embedding Feishu (Lark) Docs Inside Cognia — Options Assessment

Date: 2026-09-29 (updated same day with SDK-source deep-dive, see §Deep-dive)
Question: can the app embed Feishu cloud documents (docx/wiki/sheets/bitable) in-app?

## Verdict

**Yes, but only through the official 云文档网页组件 (Docs Component SDK).** A plain
`<iframe src="https://*.feishu.cn/docx/...">` is officially documented as broken
(third-party cookie blocking kills the login session inside the frame — even for
anonymously shared docs). The SDK path renders an authenticated iframe managed by
Feishu, using signature-based `jssdk-session` header auth instead of cookies, so
it survives third-party-cookie blocking.

The SDK path is realistic on the **Tauri desktop** shell (with real integration
work), questionable on the **Capacitor mobile** shell (not officially supported),
and awkward on the **pure browser** shell (all `open.feishu.cn` API calls —
including the ticket endpoint needed for signing — send no CORS headers, so a
browser cannot call them directly).

If the actual need is read/preview rather than live co-editing, the cheaper path
is API pull + local render, for which the repo already has infrastructure
(`lib/twin/ingest/lark-doc-fetcher.ts`).

## Path A — 云文档组件 (Docs Component SDK), the official embed

### How it works

1. Load SDK from Feishu CDN:
   `https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/docComponentSdk/lib/1.0.13.js`
   (old `h5-js-sdk` versions are deprecated; docx needs ≥ 1.1.2, the new SDK is 1.0.x).
2. Authenticate via `window.webComponent.config({...})` or the newer
   `new window.DocComponentSdk({ src, mount, auth })` constructor, then
   `component.start()`. Renders the doc inside an SDK-managed iframe.
3. Auth material = `signature`, computed server-side:
   `POST /open-apis/jssdk/ticket/get` (Bearer `user_access_token` or
   `app_access_token`) → `jsapi_ticket`; then
   `signature = sha1("jsapi_ticket=T&noncestr=N&timestamp=MS&url=PAGE_URL")`.
   Signature is valid 10 minutes and single-use. Feishu recommends doing this on
   the integrator's server; for Cognia the natural "server" is the local Rust
   bridge (`connectors_http_request` in `crates/cognia-connectors`), which the
   Lark adapter already uses because `open.feishu.cn` has no CORS headers.
4. Two identity modes:
   - **user_access_token**: doc opens as the user; full edit/comment/collab;
     the user's own doc ACL applies.
   - **app_access_token**: doc opens as the app; 100 requests/min cap; **no
     edit/comment/like** — effectively read-only.

### Requirements

- A **企业自建应用 (custom app)** on open.feishu.cn — store/marketplace apps are
  not eligible for web components.
- API permission `drive:drive` (查看、评论、编辑和管理云空间中所有文件), granted
  under the chosen identity type; may require app release + tenant-admin
  approval depending on scope review level.
- Optional `component:user_profile` / `component:selector` (user-identity only)
  for member-card and in-doc search features.

### Supported content

| Type          | Support                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| docx 云文档   | ✅ config + runtime API, actively maintained                                                  |
| wiki 文档     | ❌ direct; resolve wiki node → `obj_token`/`obj_type` = docx first (获取知识空间节点信息 API) |
| Sheet 表格    | only the `PC Header` config; no API calls; no longer updated                                  |
| 多维表格 Base | ❌                                                                                            |

### Hard limits (from FAQ + docs)

- Container **must have a fixed height** — docx cannot be height-auto, or
  lazy-load/virtual scroll breaks (images fail to load).
- The signed `url` must be the embedding page's URL (no `#`/`?`). No documented
  domain allowlist requirement for the web component itself (the "H5 trusted
  domains" / `333447`/`333448` security-domain errors belong to the separate
  client-side JSSDK used by apps running inside the Feishu client). **Deep-dive
  confirmed**: the SDK forwards `auth.url` verbatim to `signature/verify`, which
  only recomputes the SHA-1 over the submitted fields — any string consistent
  between signing and `config()` passes (docs even say LAN URLs are fine), so
  `tauri://localhost` / `cognia://localhost` / `https://localhost` should all
  verify. Residual risk = an undocumented server-side `https?://` validator —
  low, test in POC.
- Doc URL must be the correct tenant-domain URL (`bytedance.feishu.cn` vs
  `larksuite.com` vs `larkoffice.com`, SG/US regions); resolve via the
  get-document-metadata API rather than string-concatenating.
- Mention-panel search is broken in the embedded (`opendoc`) context.
- `theme` option is explicitly "不支持mobile"; docs warn against mini-program
  webviews and the FAQ reports the component prompting "upgrade" inside the
  Feishu mobile client — i.e., **mobile webview support is not certified**.
- Errors surface via `onAuthError`/`onError` codes (`NO_PERMISSION`,
  `NOT_FOUND`, `NOT_SUPPORT`, …); re-auth on auth failure is the caller's job.
- The SDK also exposes `invoke()`/`register()` runtime APIs (toggle modals,
  title-change events, feature toggles like hiding "like").

## Path B — raw iframe of the doc URL: dead end

Feishu's own FAQ (Q11) documents the two failure modes:

- Login (incl. QR-code login) cannot succeed inside the iframe — browsers block
  third-party cookies, so no session. "包括匿名文档" — even anonymously shared
  docs fail.
- Inside the Feishu mobile client the frame just prompts an upgrade.

Verified empirically: `www.feishu.cn`/`www.larksuite.com` send a
`content-security-policy-report-only` header without `frame-ancestors` (no
enforcing XFO on the marketing site), but that is moot — cookie auth, not
framing headers, is the actual wall. The aPaaS embed doc describes the same
problem class: cookie non-recognition forces either a re-login inside the frame
or a custom-domain + OAuth-integration workaround — that workaround is specific
to aPaaS pages, not general cloud docs.

## Path C — native webview window (no iframe)

For Tauri, open the docx URL in a `WebviewWindow`/panel as a **top-level**
navigation (not an iframe). No frame-ancestors issue; the user signs in once in
that webview and the session persists in the WKWebView/WebView2 cookie store.
This is "a browser pane inside the app" — the repo already ships a browser
surface (`components/browser/`, remote-Chromium canvas + iframe fallback), so
the UX pattern exists. On mobile the equivalent is the Capacitor
Browser/in-app-browser plugin, or an `applink.feishu.cn/client/web_url/open`
deep link into the Feishu app — a handoff, not an embed.

## Path D — API pull + self-render (existing precedent)

The repo already does Lark OpenAPI → local render for Sheets:
`plugins/cognia-office` syncs workbooks via `lark.sheets.*` built-in skills
rather than embedding Sheets, and `lib/twin/ingest/lark-doc-fetcher.ts` already
resolves wiki nodes → `obj_token` and pulls docx `raw_content`/blocks through
the Rust HTTP bridge (`lib/connectors/adapters/lark/authed-api.ts` —
`LARK_API_BASE = https://open.feishu.cn`, user-identity-first with silent
refresh, bot-token fallback, explicit `browserUnsupported` error off Tauri).

For docx this yields a **read mirror** (blocks → markdown/custom renderer;
or Drive `export_tasks` → PDF/DOCX → existing `cognia-pdf` preview). Docx does
have write APIs (block create/patch/delete), so two-way sync is technically
possible, but a collaborative editor is a large build — treat as out of scope.

## Fit to Cognia's three shells

| Shell                | Docs Component SDK                                                             | Webview window | API pull + render                                  |
| -------------------- | ------------------------------------------------------------------------------ | -------------- | -------------------------------------------------- |
| Browser (static out) | ticket/signature call blocked by CORS → needs a hosted helper or the Rust host | n/a            | same CORS wall → today desktop-only (`authed-api`) |
| Tauri desktop        | viable; sign via `connectors_http_request`; must widen CSP (see below)         | viable today   | viable — already implemented (`lark-doc-fetcher`)  |
| Capacitor mobile     | not officially supported; "不支持mobile" theme; POC required                   | browser plugin | viable if the Rust/companion host is reachable     |

## Integration notes for this repo

Already in place:

- Lark OAuth (PKCE, `user_access_token`, `offline_access` refresh) and scope
  merging (`LARK_SENDAS_SCOPES`, `mergeLarkScopes`, `extraScopes`) — add
  `drive:drive` (+ `docx` read scopes for Path D) to the connect flow.
- `withLarkAuthedApi` gives `GET/POST/...` against `/open-apis/*` through the
  Rust bridge — `jssdk/ticket/get` is one `post()` away, plus local SHA-1.
- `lark-doc-fetcher` already resolves `wiki/` links to `docx` tokens — reuse for
  the component's `src` (still needs correct tenant domain via metadata API).
- Frontend crypto for SHA-1: `crypto.subtle.digest` (secure contexts incl.
  `tauri://localhost`) or a tiny dep.

Missing / changes required:

- **CSP**: `src-tauri/tauri.conf.json` currently pins `script-src 'self'` and
  `frame-src 'self' blob:` — the SDK CDN (`*.feishucdn.com`) and the Feishu
  iframe (`*.feishu.cn`/`*.larksuite.com`) are both blocked. Widening
  `script-src`/`frame-src`/`connect-src`/`img-src` for Feishu domains is a
  security-relevant diff and should be scoped to the doc surface only.
- **Dev-console work**: create/extend the custom app with `drive:drive`; the
  OAuth client used by connectors today may be a different Feishu app — decide
  whether to reuse or mint a dedicated "docs embed" app id.
- **Non-HTTPS origins**: whether `DocComponentSdk` accepts a page URL of
  `tauri://localhost`/`capacitor://localhost` in the signed `url` is
  undocumented → first POC task. Fallback if it fails: serve a minimal HTTPS
  embed page on a real domain (e.g. under `web/` Cloudflare Pages) that loads
  the SDK, and frame that page (its own iframe-to-Feishu is SDK-managed).
- **Signature lifecycle**: 10-min, single-use → refresh on remount/auth-error;
  keep `nonceStr`/`timestamp`/`url` consistent between sign and `config()`.
- Container must be a **fixed height** surface (workbench panel/dock), not
  auto-height.
- Lark vs Feishu: for `larksuite.com` tenants, replace `feishu.cn` with
  `larkoffice.com` in component URLs (FAQ Q24).

## Recommendation

- **Live co-editing in-app** → Path A, desktop-first: wire `jssdk/ticket/get`
  through `authed-api`/`connectors_http_request`, sign in TS, mount
  `DocComponentSdk` in a fixed-height panel, relax CSP for Feishu domains.
  Validate `tauri://localhost` signature acceptance before committing.
- **Read/preview in-app (inbox, chat, twin)** → Path D: extend the existing
  doc-fetcher to blocks (not just `raw_content`) or `export_tasks` → PDF.
- **Mobile** → Path C handoff (open in Feishu app / in-app browser) until the
  component is certified there.

## Deep-dive: SDK internals & non-HTTPS origins (2026-09-29, read-only)

Verified by decompiling `docComponentSdk/lib/1.0.13.js` (238 KB, fetched from the
documented CDN — no repo code touched).

### Runtime mechanism

1. Host page calls `POST {open.feishu.cn}/open-apis/h5-jssdk/signature/verify`
   **directly from the browser** (axios) with
   `{open_id, signature, app_id, timestamp, nonce_str, url, js_api_list, tenant_key}`
   → returns `jssdk_session`. This endpoint is by design CORS-enabled — it is the
   client-side half of the flow (the CORS wall only applies to ordinary
   `open-apis/*`, incl. `jssdk/ticket/get`).
2. SDK fetches an RSA public key (`publicKeyHost`, cached in
   `localStorage["__opendoc_public_key__"]`), encrypts the session →
   `encrypt_jssdk_session`.
3. SDK mounts an unsandboxed iframe (`name="docComponent-<id>"`,
   `allow="fullscreen;clipboard-read *;clipboard-write *;local-network-access *"`)
   whose `src` = the doc URL + query:
   `opendoc=1&ccm_open=iframe&doc_app_id=<appId>&theme=…&docComponentConfig=…&encrypt_jssdk_session=…&auth_config=…`.
4. `postMessage` handshake (targetOrigin = iframe's feishu origin) delivers
   `{jssdkSession, appId}` to the inner app; all inner API calls then run under
   `jssdk-session` header auth. No cookies anywhere in the chain.

### `src` acceptance regex (from the bundle)

```ts
;/^((?:docsource:|nativerequest:|https?:\/\/)[^\s]+)\/(docs|docx|wiki|sheets)\/([^\s]{20,})/
```

`docs|docx|wiki|sheets` URL patterns are accepted client-side; `/base/` does not
match → `NOT_SUPPORT (-100)`. `wiki` passing the regex contradicts the docs
matrix — resolve wiki → `obj_token` anyway rather than trusting it.

### Origin verdict (refined)

| Shell origin                           | signature/verify           | ticket/get (signing prereq)             | Overall                                       |
| -------------------------------------- | -------------------------- | --------------------------------------- | --------------------------------------------- |
| `tauri://localhost` (macOS)            | passes — `url` is a string | via `connectors_http_request` (no CORS) | **high-confidence feasible**; needs CSP delta |
| `http://tauri.localhost` (Windows)     | passes                     | same                                    | same                                          |
| `https://localhost` (Android)          | passes                     | via CapacitorHttp/companion             | feasible; mobile UX uncertified               |
| `cognia://localhost` (iOS)             | passes (residual: scheme)  | same                                    | same                                          |
| browser (`https://<domain>`/localhost) | passes                     | **blocked — needs hosted helper**       | blocked unless a backend mints tickets        |

`mobile/capacitor.config.ts` confirms the real origins (`scheme: "cognia"` iOS,
`androidScheme: "https"`). `localStorage`, postMessage, and iframe loading all
behave normally on these origins — nothing in the chain depends on the host
being http(s) except a possible server-side `url` schema check (unverifiable
without real app credentials; rate low).

### Exact CSP delta (tauri.conf.json `app.security.csp`)

Current: `script-src 'self' 'wasm-unsafe-eval' blob:` + `frame-src 'self' blob:`.
Needed for Path A (CDN route):

```
script-src … https://sf1-scmcdn-cn.feishucdn.com        # SDK loader (or vendor it → no change)
frame-src … https://*.feishu.cn https://*.larksuite.com # opendoc iframe
connect-src … https://open.feishu.cn                    # signature/verify + public-key fetch
```

Vendoring the 238 KB SDK into `out/` removes the `script-src` delta entirely;
`frame-src`/`connect-src` are unavoidable for the iframe + verify call. The
iframe's own subresources load inside Feishu's document and are not governed by
our CSP.

### POC plan (no existing-code changes)

1. **Ops**: dev console — custom app, add `drive:drive` under user identity,
   publish (tenant-admin approval may apply); create a test docx, grant it to
   the test user.
2. **Sign**: `authed-api.post("/open-apis/jssdk/ticket/get")` (existing bridge)
   → `jsapi_ticket`; SHA-1 via `crypto.subtle` over
   `jsapi_ticket&noncestr&timestamp&url` with `url = location.href.split("#")[0]`.
3. **Mount**: new component — fixed-height container + `DocComponentSdk({src,
mount, auth:{openId, signature, appId, timestamp, nonceStr, url,
jsApiList:["DocsComponent"]}})`; SDK vendored as a static asset to avoid the
   `script-src` change; `frame-src`/`connect-src` widened for feishu domains.
4. **Verify matrix**: `pnpm tauri dev` (tauri:// origin) → load doc, edit,
   comment; then Windows `http://tauri.localhost`; then Android
   `https://localhost`; iOS last (highest residual risk).
5. **Fallback if scheme rejected**: hosted HTTPS embed page (e.g. on `web/`
   Cloudflare Pages) wrapping the SDK; iframe that page or open in a
   `WebviewWindow`.

## Sources

- Web components overview:
  https://open.feishu.cn/document/uYjL24iN/uQDO3YjL0gzN24CN4cjN/web-component-overview
- Docs component quick start (SDK URL, params, error codes):
  https://open.feishu.cn/document/common-capabilities/web-components/uYDO3YjL2gzN24iN3cjN/introduction
- Access notice (doc-type support matrix, jssdk-session auth):
  https://open.feishu.cn/document/web-components/uYDO3YjL2gzN24iN3cjN/access-notice
- Component SDK auth flow (ticket → sha1 signature, 10-min single-use):
  https://open.feishu.cn/document/common-capabilities/web-components/component-sdk-authentication-process
- FAQ (Q11 iframe dead incl. anonymous docs; fixed-height requirement;
  mention-search caveat; feishu.cn→larkoffice.com):
  https://open.feishu.cn/document/uYjL24iN/uYDO3YjL2gzN24iN3cjN/faq
- aPaaS embed SSO doc (third-party cookie problem class):
  https://ae.feishu.cn/hc/zh-CN/articles/791095461404
- Repo: `lib/connectors/adapters/lark/` (oauth-begin, auth, authed-api),
  `lib/twin/ingest/lark-doc-fetcher.ts`, `plugins/cognia-office/plugin.json`,
  `src-tauri/tauri.conf.json` (CSP), `components/browser/`.
