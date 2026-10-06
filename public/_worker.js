// Cloudflare Pages Function (advanced mode) for the public share host
// (share.cognia.cn) — ADR-0037 Phase 4, services/share-server/pages/README.md.
//
// The whole app static export is uploaded to the Pages project so /share/view
// can reuse the app runtime (A2UI renderer, Tailwind, Next client). Only the
// viewer and /pair (browser pairing onboarding for relay remote access) are
// meant to be public: every other route redirects to the viewer, while real
// asset files (anything with an extension, plus /_next/*) serve straight
// through. The /v1/* JSON API is intercepted upstream by the cognia-share
// Worker's zone route, so it never reaches this function.
//
// Inert outside Pages: Tauri/Capacitor serve the bundle over custom protocols
// and `next dev` treats this as a plain public/ asset.
const sharePagesWorker = {
  fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname
    const isViewer = path === "/share/view" || path.startsWith("/share/view/")
    const isPair = path === "/pair"
    const isAsset = path.startsWith("/_next/") || /\.[a-z0-9]{1,8}$/i.test(path)
    if (isViewer || isPair || isAsset) return env.ASSETS.fetch(request)
    url.pathname = "/share/view"
    url.search = ""
    return Response.redirect(url.toString(), 302)
  },
}

export default sharePagesWorker
