/**
 * E2E: install vscode-eslint.vsix and confirm diagnostics light up on
 * a TypeScript Skill. This is Phase A's gate test for the
 * `.vsix`-bundled LSP path (see ~/.claude/plans/vscode-lsp-mighty-robin.md).
 *
 * Prerequisites — when missing, the suite uses `test.skip()` so CI without
 * the network can still run a green build:
 *
 *   1. A signed `dbaeumer.vscode-eslint-X.Y.Z.vsix` cached under
 *      `tests/e2e/lsp/fixtures/`. CI should pre-fetch the latest release
 *      via Open VSX in `tests/e2e/global-setup.ts`.
 *   2. The Tauri dev runtime must be available — the VS Code extension
 *      host binary is desktop-only. Playwright `webServer` should be the
 *      Tauri dev shell, not a plain `next dev`.
 *
 * The spec drives the canonical install → activate → edit → diagnostic
 * pipeline end-to-end with no mocks. Assertions check for the actual
 * marker counts Monaco renders.
 */

import fs from "fs"
import path from "path"
import { expect, test } from "@playwright/test"

const FIXTURE_DIR = path.join(__dirname, "fixtures")
const FIXTURE_PATTERN = /^dbaeumer\.vscode-eslint-.*\.vsix$/

function resolveFixturePath(): string | null {
  if (!fs.existsSync(FIXTURE_DIR)) return null
  const matches = fs.readdirSync(FIXTURE_DIR).filter((f) => FIXTURE_PATTERN.test(f))
  if (matches.length === 0) return null
  return path.join(FIXTURE_DIR, matches[0]!)
}

function isTauriBuild(): boolean {
  // The Playwright config can opt in via the `TAURI_E2E=1` env var when
  // launching the Tauri dev shell. Non-Tauri runs (plain `next dev`)
  // can't host the VS Code sidecar, so the test would never pass.
  return process.env.TAURI_E2E === "1"
}

test.describe("VS Code .vsix LSP — diagnostics smoke (Phase A gate)", () => {
  const fixturePath = resolveFixturePath()
  const tauri = isTauriBuild()
  const reason: string[] = []
  if (!fixturePath) reason.push("missing fixture .vsix under tests/e2e/lsp/fixtures/")
  if (!tauri) reason.push("Tauri dev shell not detected (TAURI_E2E !== '1')")

  test.skip(
    !fixturePath || !tauri,
    `Skipping vscode-eslint E2E because: ${reason.join("; ")}.\n` +
      "To enable: run with `TAURI_E2E=1` against `pnpm tauri dev`, and " +
      "pre-fetch dbaeumer.vscode-eslint-*.vsix into tests/e2e/lsp/fixtures/."
  )

  test("Drag-installs the .vsix, activates it, and surfaces diagnostics on a TS Skill", async ({
    page,
  }) => {
    // 1. Open the plugins workspace and switch to the "install from .vsix" entry.
    await page.goto("/plugins?tab=installed")
    await expect(page.getByRole("heading", { name: /plugins/i })).toBeVisible()

    // 2. Drag-drop the .vsix file. Cognia's installer accepts files via a
    //    drop target on the workspace shell; the input below is the
    //    accessible fallback the responsive sweep already exercises.
    const fileChooser = page.locator("input[type=file][accept*='.vsix']").first()
    await fileChooser.setInputFiles(fixturePath!)

    // 3. Permission review dialog — the static analysis identifies
    //    `child_process.spawn` (LSP server) + `filesystem:read/write`
    //    (workspace files). Accept.
    const reviewDialog = page.getByRole("dialog", { name: /permission review/i })
    await expect(reviewDialog).toBeVisible({ timeout: 10_000 })
    await expect(reviewDialog).toContainText(/process:spawn|child_process/i)
    await reviewDialog.getByRole("button", { name: /install|accept/i }).click()

    // 4. Wait for activation — the sidecar logs `Sidecar::spawn` when
    //    the .vsix binary runs. We surface that as a toast / status row.
    await expect(page.getByText(/vscode-eslint.*activated/i)).toBeVisible({ timeout: 20_000 })

    // 5. Navigate to Skills, create a fresh TS file with two intentional
    //    ESLint errors, and wait for the LSP server to lint.
    await page.goto("/skills")
    await page.getByRole("button", { name: /new skill/i }).click()
    await page.getByRole("textbox", { name: /name/i }).fill("e2e-lsp-eslint")
    await page.getByRole("button", { name: /create/i }).click()

    const editor = page.locator("[data-testid='monaco-editor']").first()
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.type("const x = 1; const x = 2;\n")

    // 6. Marker assertion — Monaco renders ESLint diagnostics as
    //    `.squiggly-error` overlays in its glyph margin. Wait for the
    //    redeclaration error (the LSP needs a moment to lint).
    await expect(page.locator(".squiggly-error").first()).toBeVisible({ timeout: 15_000 })

    // 7. Hover the redeclaration — Monaco's hover popup carries the
    //    ESLint rule name.
    await editor.hover({ position: { x: 60, y: 16 } })
    await expect(page.getByText(/no-redeclare/i).first()).toBeVisible({ timeout: 5_000 })

    // 8. Disable the extension and verify diagnostics clear.
    await page.goto("/plugins?tab=installed")
    await page
      .getByRole("row", { name: /vscode-eslint/i })
      .getByRole("switch")
      .click()
    await page.goto("/skills")
    await expect(page.locator(".squiggly-error")).toHaveCount(0, { timeout: 15_000 })
  })
})
