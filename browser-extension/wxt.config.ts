import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "wxt"

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const extensionIcons = {
  16: "/icon-16.png",
  32: "/icon-32.png",
  48: "/icon-48.png",
  128: "/icon-128.png",
}

/**
 * Cognia Browser Companion — Chrome MV3, Edge on the same package.
 *
 * The permission set is the product decision, not a build detail, so it is
 * worth reading as one:
 *
 *  - **No `<all_urls>`, no static `content_scripts`.** The starter this began
 *    from had both. They would have made "Read and change all your data on all
 *    websites" the install prompt for a feature that reads a page only after
 *    the user asks it to.
 *  - **`activeTab` + `scripting`.** Together these grant one tab's DOM, and
 *    only after a toolbar click, a keyboard shortcut or a context-menu choice.
 *    The grant expires on navigation. That is the same gesture-scoped access
 *    the feature already requires by design, so nothing broader is needed.
 *  - **`http://127.0.0.1/*` is OPTIONAL.** It is requested during pairing, not
 *    at install, so somebody who installs the extension and never pairs has
 *    granted nothing.
 *  - **No `debugger`, `history`, `downloads`, `tabCapture` or
 *    `nativeMessaging`.** `chrome.debugger` in particular cannot be requested
 *    optionally and its warning ("read and change all your data on all
 *    websites") would change the extension's trust posture wholesale. Page
 *    automation is out of scope (ADR-0154 §1); when it is wanted,
 *    `playwright-existing-browser` already does it.
 *  - **`incognito: "not_allowed"`.** A private window is the clearest possible
 *    statement that a page is not to be handed anywhere.
 *
 * Chrome 116 is the floor because `chrome.sidePanel.open()` — opening the panel
 * from a user gesture — landed there; the API itself exists from 114, but a
 * panel the user cannot open from the toolbar is not the product.
 */
export default defineConfig({
  srcDir: "src",
  entrypointsDir: "app",
  outDir: "build",
  modules: ["@wxt-dev/module-react"],
  imports: false,
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    icons: extensionIcons,
    default_locale: "en",
    minimum_chrome_version: "116",
    permissions: ["sidePanel", "storage", "activeTab", "scripting", "contextMenus"],
    optional_host_permissions: ["http://127.0.0.1/*"],
    incognito: "not_allowed",
    action: { default_title: "__MSG_actionTitle__", default_icon: extensionIcons },
    commands: {
      "capture-page": {
        suggested_key: { default: "Alt+Shift+C" },
        description: "__MSG_captureCommand__",
      },
    },
  },
  // The bundler twin of the `paths` in tsconfig.json. Both are needed: tsc
  // reads one, Vite the other, and a mismatch between them compiles cleanly
  // and then fails to bundle.
  alias: {
    "@ext": here("."),
    "@cognia/plugin-ui": here("../packages/plugin-ui/src/index.ts"),
  },
  vite: () => ({ plugins: [tailwindcss()] }),
})
