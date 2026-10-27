# Evidence ledger: macOS menu bar template icon

- Status: verifying
- Lane: standard
- Created: 2026-10-26
- Updated: 2026-10-26
- Related: ADR-0165; ADR-0225

## Original request

> 有个问题，现在在macos上cognia的桌面端任务栏图标和苹果主体很不匹配

## Knowledge

| ID  | Statement                                                                                                                         | State    | Basis                                                                                                        | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | The menu bar shows a detailed color character among monochrome icons.                                                             | Observed | User screenshot, 2026-10-26, macOS                                                                           | -          |
| O2  | Before repair, startup used the window icon, renderer rasters composited the character and native updates disabled template mode. | Verified | src-tauri/src/tray/mod.rs, icon_state.rs; lib/tray/icon-builder.ts, 2026-10-26                               | -          |
| O3  | Pinned Tauri 2.12.0 supports atomic icon/template updates; AppKit template rendering uses alpha.                                  | Verified | Installed Tauri tray source; https://developer.apple.com/documentation/appkit/nsimage/istemplate; 2026-10-26 | -          |
| C1  | Keep state indicators, usage badge text, tray interactions and other platforms' existing artwork.                                 | Observed | Existing tray implementation and ADR-0165/0225, 2026-10-26                                                   | -          |
| G1  | Use a custom, recognizable monochrome Cognia mark that follows macOS appearance from startup through state updates.               | Revised  | User issue, interpreted as a request to fix menu bar appearance, 2026-10-26                                  | O1         |

| O4 | User rejected the generic line-icon appearance and requested a better-looking design. | Observed | User feedback: 这样不好看啊，能不能更好看一些; 2026-10-26 | - |

## Problem frame

Fix the menu bar appearance (G1) by using a custom filled orbital C with state details as template images on macOS, covering native bootstrap and renderer replacement (O2, O3). Preserve status/usage readability and interactions (C1). Dock/application artwork is outside this change. Extend the existing native and renderer icon modules; one embedded PNG is required because the native bootstrap runs before the renderer can rasterize SVG.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                      |
| ------------ | ------ | ---------------------------------------------------------------- |
| scale        | low    | Two native files and the existing rasterizer/test.               |
| technical    | low    | Custom vector geometry, existing canvas and Tauri template APIs. |
| coupling     | medium | Both bootstrap and renderer replacement must agree on alpha.     |
| requirement  | low    | Screenshot identifies menu bar, rather than Dock.                |
| verification | medium | Native appearance needs a real macOS status item.                |
| risk         | low    | Reversible visual change with no data or permissions changes.    |

## Risks

| ID  | Risk (impact)                                                  | Severity | Source                                                  | Claim                                                        | Refuted by                                               |
| --- | -------------------------------------------------------------- | -------- | ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| R1  | Opaque character or badge becomes a solid template silhouette. | medium   | AppKit template documentation; existing canvas pipeline | macOS uses transparent state glyphs and cutout badge text.   | Character loads on macOS or badge text has opaque alpha. |
| R2  | Startup/state updates revert to color or flicker.              | medium   | Installed Tauri atomic-update documentation; O2         | Bootstrap and swaps both enable template mode.               | Color icon at startup or after any state swap.           |
| R3  | Other platforms or tray interactions regress.                  | medium   | Cognia risk catalog; ADR-0225                           | Other platforms retain character artwork; clicks still work. | Changed non-macOS raster sequence or dead native click.  |

## Verification obligations

| ID  | Risk       | Method                                                                    | Independence | Evidence                                                                                                                                                                                                                                                                                                                                                                                               | Coverage                                                                                                                                     | Status  |
| --- | ---------- | ------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R3     | Focused Jest regression suite and real WKWebView raster alpha inspection. | tool         | Redesign regression first failed: 3 failed, 13 passed (custom builder absent). Final focused suite: 36 passed. Latest smoke: idle/busy/error/muted have 0 colored pixels and 872–927 transparent pixels; integrated cutout text check passed.                                                                                                                                                          | Stable C silhouette, four distinct status details, badge cutouts, non-macOS character path; no coverage                                      | passed  |
| V2  | R2         | Native source tests and Rust compile/test.                                | tool         | `rustc --test .cache/macos-tray/native-tests.rs` with the active Cargo build’s exact dependency artifacts: 11 passed, including production icon_state.rs and dto.rs tests. Existing watched Tauri Cargo dev build compiled and relaunched the repaired app.                                                                                                                                            | Embedded 36×36 black/alpha bootstrap, source compilation, atomic swaps; full Cargo unit suite not run                                        | passed  |
| V3  | R1, R2, R3 | Real Tauri menu bar smoke and appearance inspection.                      | real-env     | `.cache/macos-tray/native-flow.json`: idle/busy/error/muted applied and read back, original idle restored, 20 menu items unchanged; panel yielded 46 semantic nodes and closed successfully. `.cache/macos-tray/smoke.json`: real WKWebView raster checks passed with 0 new console errors during probe. Menu bar screenshot and physical tray clicks unavailable through current native app bindings. | Production IPC/state swaps and panel lifecycle passed; actual menu bar light/dark/highlight appearance and physical clicks remain unverified | blocked |
| V4  | R3         | Scoped lint, type checks and independent preflight audit.                 | tool         | Changed TypeScript ESLint passed with 0 warnings; Prettier, rustfmt and scoped git diff --check passed. Rust and test-gap auditors found no blockers; integrated badge test added from audit feedback. Redesign `pnpm typecheck` again reports 8 unrelated errors in hooks/chat/use-claude-chat.test.ts and lib/connectors/adapters/discord/avatar{,.test}.ts, none in changed sources.                | Changed sources and integration call sites passed; root typecheck remains red on unrelated changes                                           | blocked |

## Decisions

| ID  | Date       | Decision                                                                                            | Action    | Based on       | Reversal trigger                                                      |
| --- | ---------- | --------------------------------------------------------------------------------------------------- | --------- | -------------- | --------------------------------------------------------------------- |
| D1  | 2026-10-26 | Use existing state glyphs on macOS, an embedded idle glyph at bootstrap, and atomic template swaps. | implement | O1, O2, O3, C1 | Native template rendering fails to retain state or badge readability. |

| D2 | 2026-10-26 | Re-enter visual design after user rejection. Choose a filled orbital C with a sparkle from three geometry studies; keep the C silhouette fixed across statuses. | implement | O4, C1, O3 | User rejects the new geometry, or it loses legibility at 18 pt. |

## Residual risks

| ID  | Residual                                                                                      | From   | Why still open                                                                                                                                           | Next action                                                                                            | Status |
| --- | --------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Actual OS light/dark/highlight appearance and physical tray clicks are not visually verified. | V3, M1 | CUA cannot bind the bare development binary; available window captures do not include the native menu bar and returned unrelated visible screen content. | Inspect the running development app’s status item in both system appearances and click its panel/menu. | open   |
| X2  | Root typecheck is blocked by 8 errors outside this change.                                    | V4     | Existing shared working-tree chat test typing and Discord BigInt target errors.                                                                          | Owners repair those files, then rerun pnpm typecheck.                                                  | open   |

| X3 | Post-relaunch webview readiness is pending. | V3 | Native rebuild completed, but the replacement Next dev process is still compiling the root page and the helper reports waiting_for_page. | Inspect the replacement managed run log/status, then rerun native-flow.mjs once ready. | open |

## Outcome

| ID  | Signal                                                                | How / when measured                                                                                     | Result                                                                                                                                                                | Status  |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | Generic line icon improves the original appearance.                   | User feedback on 2026-10-26.                                                                            | User rejected its appearance; native template mechanics alone did not satisfy the goal.                                                                               | not-met |
| M2  | Custom orbital C improves recognizability while fitting the menu bar. | Compare `.cache/macos-tray/candidates.png` and `.cache/macos-tray/preview.png`, then native 18 pt item. | Three vector studies inspected; Orbit selected for balanced weight and clear C/negative space. New preview delivered in chat; user visual acceptance remains pending. | pending |

## Design refinement

North star: a quiet, distinct Cognia monogram that reads at 18 pt. The original application artwork uses a surrounding technology orbit, which informs the new C/stellar opening; the C is a new menu bar monogram, not a claim that it is the existing app logo. Compare against the user screenshot: neighboring icons have clear silhouettes and compact spacing, while the original avatar loses detail. Choose the Orbit study over Ribbon (slanted weight) and Lunar (denser crescent). Retain transparent monochrome rendering, use a filled C, and change only the opening detail for status. No decorative animation is added to the persistent menu bar. Local self-review only for visual quality; test-gap review independently confirms registration wiring and tests.

The workstation reached ENOSPC during editing. Removed the completed task-generated native test executable and three inactive generated cognia_companion incremental-cache directories after process/lsof checks; source and active compilation outputs were retained. The desktop dev server returned HTTP 500 after a Turbopack PoisonError, requiring managed-run recovery before the final native smoke.

Final refinement checks: 36 focused Jest tests and 11 native source/asset tests passed, scoped ESLint and Prettier passed, and typecheck still reports exactly 8 unrelated errors. Native rebuilt successfully, including a subsequent cached relaunch (`dev` profile, 3.86 s). Managed stop initially refused while the app was rebuilding; it succeeded once native run identity became reachable. The replacement managed run is `.cache/tauri-agent-debug/2026-10-26T12-13-58-768Z` and remains running to restore the initial development state. At handoff its native endpoint responds but the webview is still waiting for the frontend first compilation, so post-relaunch UI smoke is pending.
