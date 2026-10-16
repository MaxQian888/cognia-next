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
 * worth reading as one (ADR-0154 §1, amended by ADR-0228):
 *
 *  - **Install asks for nothing that reads a page.** `activeTab` + `scripting`
 *    grant one tab's DOM only after a toolbar click, a shortcut or a context
 *    menu choice, and the grant expires on navigation. `alarms` (the status
 *    poll while the panel is closed) and `tabGroups` (the "Cognia" group an
 *    agent's tabs live in) carry no install warning.
 *  - **Everything broader is optional, asked for inside a gesture in the
 *    panel, by the feature that needs it:** `http://127.0.0.1/*` at pairing;
 *    `tabs` and a page's own origin when the person adds another tab to a
 *    capture; `<all_urls>` when they turn on agent mode; `notifications`,
 *    `downloads` and `cookies` from their settings toggles. Somebody who
 *    installs and never opts in has granted what the original build did.
 *  - **No static `content_scripts`.** The extractor, the overlay and the page
 *    hooks are injected per use through `chrome.scripting`.
 *  - **No `debugger`, `history`, `tabCapture`, `webRequest` or
 *    `nativeMessaging`.** `chrome.debugger` cannot be requested optionally and
 *    its warning would change the extension's trust posture wholesale; what
 *    needs it is refused by the extension engine, naming `user-chrome`.
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
    permissions: [
      "sidePanel",
      "storage",
      "activeTab",
      "scripting",
      "contextMenus",
      "alarms",
      "tabGroups",
    ],
    optional_permissions: ["tabs", "notifications", "downloads", "cookies"],
    optional_host_permissions: ["http://127.0.0.1/*", "<all_urls>"],
    incognito: "not_allowed",
    action: { default_title: "__MSG_actionTitle__", default_icon: extensionIcons },
    // Chrome honours at most four suggested shortcuts; these are all four.
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+O" },
        description: "__MSG_openPanelCommand__",
      },
      "capture-page": {
        suggested_key: { default: "Alt+Shift+C" },
        description: "__MSG_captureCommand__",
      },
      "capture-selection": {
        suggested_key: { default: "Alt+Shift+S" },
        description: "__MSG_captureSelectionCommand__",
      },
      "capture-article": {
        suggested_key: { default: "Alt+Shift+A" },
        description: "__MSG_captureArticleCommand__",
      },
    },
    omnibox: { keyword: "cog" },
  },
  // The bundler twin of the `paths` in tsconfig.json. Both are needed: tsc
  // reads one, Vite the other, and a mismatch between them compiles cleanly
  // and then fails to bundle.
  alias: {
    "@ext": here("."),
    "@cognia/plugin-ui": here("../packages/plugin-ui/src/index.ts"),
    // The embedded engine's overlay, bundled into `/agent-overlay.js` rather
    // than copied: one file, so the agent's snapshot refs cannot drift between
    // the in-app browser and the user's own tabs (ADR-0228 §6).
    "@cognia-overlay": here("../lib/browser/overlay.injected.js"),
  },
  vite: () => ({ plugins: [tailwindcss()] }),
})
