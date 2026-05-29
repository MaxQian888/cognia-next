# cognia share viewer — Cloudflare Pages

The public share viewer is **not** a separate app. It is the app's own
`/share/view` route (`app/share/view/page.tsx`), which ships in the normal
static export (`out/`). Deploying that export to Cloudflare Pages gives shared
links a real browser renderer that already carries the A2UI renderer, Tailwind,
and the Next runtime — which a standalone Vite viewer could not import (ADR-0037
Phase 4). The same route also renders inside the Tauri desktop shell, so an
owner can open their own shares without leaving the app.

## How a share is opened

A minted link looks like:

```
https://share.cognia.cn/share/view?c=<code>#k=<key>
```

- `c=<code>` — the public lookup id (query param).
- `#k=<key>` — the AES-256 decryption key. It rides in the URL `#fragment`,
  which browsers never send to any server, so neither Pages nor the Worker ever
  sees it. The route reads it client-side after hydration and decrypts locally.

The route fetches the opaque envelope from the Worker API
(`GET https://share.cognia.cn/v1/share/<code>`, CORS `*`) and decrypts it with
the fragment key. Because the key only travels in the fragment, the link must be
reached by a normal navigation or direct open — **never an HTTP 30x redirect**,
which would drop the fragment.

## Deploy

```bash
# from the repo root — produces the full static export in ./out
pnpm build

# deploy out/ to a Pages project on the share host
wrangler pages deploy out --project-name cognia-share-viewer
```

Bind the Pages project to `share.cognia.cn`. The Worker route
`share.cognia.cn/v1/*` (see `../worker/wrangler.toml`) takes precedence over the
Pages project on that path, so `/v1/*` hits the API and everything else
(including `/share/view`) is served by Pages.

## Notes

- **The whole app shell is published.** `out/` is a monolithic export, so the
  entire static client becomes reachable at the Pages host. This is a
  secret-free client bundle (all credentials live in the desktop keyring / local
  Dexie, never in the export), so it is safe to expose, but be aware that paths
  other than `/share/view` resolve to the app shell. If you want only the viewer
  exposed, add a Pages redirect/`_redirects` rule sending non-`/share/view`
  paths to `/share/view`.
- Keep the host in sync with the app's `NEXT_PUBLIC_SHARE_URL` /
  `DEFAULT_SHARE_URL` (`lib/share/config.ts`).
