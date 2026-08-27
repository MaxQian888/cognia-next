import React from "react"
import ReactDOM from "react-dom/client"

import { SidePanel } from "@ext/src/components/side-panel"
import { createChromeBrowserApi } from "@ext/src/lib/chrome-browser-api"
import "@ext/src/styles/tokens.css"

/**
 * The panel's only job here is to hand the real `chrome.*` surface to code
 * that does not import it. Everything under `src/lib` and `src/components`
 * takes a {@link BrowserApi} instead, which is what lets the whole panel be
 * rendered in a test without a browser extension host.
 */
const root = document.getElementById("root")
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <SidePanel api={createChromeBrowserApi()} />
    </React.StrictMode>
  )
}
