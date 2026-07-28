import { test as base, type ConsoleMessage, type Request, type Response } from "@playwright/test"

import { redactE2EDiagnosticText, redactE2EDiagnosticUrl } from "@/lib/test/e2e-diagnostics"

export { expect } from "@playwright/test"
export type {
  BrowserContext,
  ConsoleMessage,
  Locator,
  Page,
  WebSocketRoute,
} from "@playwright/test"

type DiagnosticRecord = {
  kind: "console" | "page-error" | "request-failed" | "server-response"
  message: string
  method?: string
  status?: number
  url?: string
}

const MAX_DIAGNOSTICS = 100

export const test = base.extend<{ collectDiagnostics: void }>({
  collectDiagnostics: [
    async ({ page }, use, testInfo) => {
      const records: DiagnosticRecord[] = []
      const record = (diagnostic: DiagnosticRecord) => {
        if (records.length < MAX_DIAGNOSTICS) {
          records.push(diagnostic)
        }
      }

      const onConsole = (message: ConsoleMessage) => {
        if (message.type() === "error") {
          record({
            kind: "console",
            message: redactE2EDiagnosticText(message.text()),
          })
        }
      }
      const onPageError = (error: Error) => {
        record({
          kind: "page-error",
          message: redactE2EDiagnosticText(error.stack ?? error.message),
        })
      }
      const onRequestFailed = (request: Request) => {
        record({
          kind: "request-failed",
          message: redactE2EDiagnosticText(
            request.failure()?.errorText ?? "Unknown network failure"
          ),
          method: request.method(),
          url: redactE2EDiagnosticUrl(request.url()),
        })
      }
      const onResponse = (response: Response) => {
        if (response.status() >= 500) {
          record({
            kind: "server-response",
            message: response.statusText(),
            method: response.request().method(),
            status: response.status(),
            url: redactE2EDiagnosticUrl(response.url()),
          })
        }
      }

      page.on("console", onConsole)
      page.on("pageerror", onPageError)
      page.on("requestfailed", onRequestFailed)
      page.on("response", onResponse)

      await use()

      page.off("console", onConsole)
      page.off("pageerror", onPageError)
      page.off("requestfailed", onRequestFailed)
      page.off("response", onResponse)

      if (records.length > 0) {
        await testInfo.attach("browser-diagnostics.json", {
          body: Buffer.from(JSON.stringify(records, null, 2)),
          contentType: "application/json",
        })
      }
    },
    { auto: true },
  ],
})
