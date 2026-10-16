import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"
import { capturePage } from "../lib/capture/page-capture"

export default defineUnlistedScript(() => {
  globalThis.__cogniaPageCapture ??= {
    capture(options) {
      return capturePage(document, options)
    },
  }
})
