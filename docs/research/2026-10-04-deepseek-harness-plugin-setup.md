# DeepSeek Harness plugin setup — 2026-10-04

This records the applied standalone DSH setup after the user requested an expanded plugin set. It supersedes the proposal status in [the research shortlist](2026-10-04-deepseek-harness-plugin-shortlist.md). No Cognia application source was changed.

## Runtime and profiles

- CLI upgraded from `0.1.0-rc.7` to npm `latest`, `0.2.0-rc.2`, as observed on 2026-10-04. The newer alpha channel was not selected.
- Main profile: `/Users/bytedance/.dsh/profiles/web`.
- Terminal profile: `/Users/bytedance/.dsh/profiles/tui`.
- Start Web: `dsh web`. Start terminal UI: `dsh --profile tui`.
- Exact direct dependency versions are saved in the profile manifests and lockfiles. Community packages use the installed host services; old peer-dependency warnings were not resolved by installing a second host runtime.
- The TUI is a separate base-plus-TUI profile. Web UI plugins and the Web MCP/LSP configuration are not automatically shared with it.

## Installed and enabled

| Capability                              | Package/version                                                           | Configuration and verification                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin discovery and management         | `dshmarket@1.66.8`                                                        | Settings → Plugin Market opens; Discover, Themes, Favorites and Installed tabs render; the live catalog populated with plugin cards. No remote backup account or automatic bulk update configured.                                                                                        |
| Context and token inspection            | `dsh-context@0.63.0`                                                      | Active host component; tab placement, per-step detail, delta trends, size sorting. No model run was made to validate generated context charts.                                                                                                                                            |
| Cost monitoring                         | `dsh-cost-meter@1.8.10`                                                   | Active host component; existing local usage history imported and balance UI rendered. Billing reconciliation against a newly billed model run was not tested.                                                                                                                             |
| Prompt templates                        | `dsh-prompt@0.2.10`                                                       | Prompt button opens populated template categories and cards. No template was submitted to a model.                                                                                                                                                                                        |
| Session management                      | `dsh-session-manager@0.6.2`                                               | Existing sessions render in the manager. Some tag/note/priority/favorite controls are disabled under this host; do not assume the full upstream feature set is available. Archive, move and delete were not exercised on real sessions.                                                   |
| Artifact previews                       | `dsh-artifact@0.7.0`                                                      | Artifact tool registered and All artifacts panel opened. Limits: 400,000 characters and 5 versions per artifact. Generated artifact execution was not tested.                                                                                                                             |
| Repository setup recommendations        | `dsh-repo-setup@0.1.7`                                                    | Active component and `repo_setup_scan` registered. Source exposes a local read-only scanner. Its recommendations remain suggestions, not automatic installs.                                                                                                                              |
| Local notifications                     | `@goodandready/dsh-plugin-notify@0.3.8`                                   | Task completion, errors and approval requests; local notifications and toasts enabled, sounds/browser desktop notifications disabled, background-only. Webhooks empty. Actual OS notification delivery was not exercised.                                                                 |
| TypeScript and Rust code navigation     | `@deepseek-ai/dsh-lsp`, `dsh-lsp-stdio`, `dsh-tool-lsp`, all `0.2.0-rc.2` | Actual TypeScript definition lookup and Rust hover passed against disposable files. Uses existing `typescript-language-server@5.3.0`, profile-local `typescript@6.0.3`, and Rust analyzer from toolchain `1.96`. This tool supports navigation/hover, not compiler diagnostics or rename. |
| Current library documentation           | Context7 hosted MCP, shipped official DSH MCP client                      | Handshake, tool discovery, real Next.js library lookup passed; tools also registered inside DSH. Public endpoint configured without a new API key.                                                                                                                                        |
| Browser automation                      | `@playwright/mcp@0.0.83`                                                  | Handshake, discovery and real navigation to a disposable HTTP fixture passed; tools registered inside DSH. Uses existing Chrome, isolated headless session.                                                                                                                               |
| Terminal interface                      | `@deepseek-harness-tui/dsh-tui@0.12.0`                                    | Separate profile. Active services verified; a real pseudo-terminal rendered Sessions/workspaces. Interactive model completion was not tested.                                                                                                                                             |
| Existing workflow skills                | Official skill filesystem provider, bundled `0.2.0-rc.2`                  | Retains default project `.agents/skills` and user `~/.agents/skills` discovery. Existing workflows were not duplicated into multiple competing skill packs.                                                                                                                               |
| Session full-text search infrastructure | Shipped `session-query-sqlite`                                            | Enabled lazy initialization on first search with an in-memory index; no persistent second index added. Full-text query behavior was not separately exercised.                                                                                                                             |

## Prepared or retained, disabled

| Integration                   | State                                   | Reason / next action                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chrome DevTools MCP `1.10.1`  | Installed and configured, disabled      | Tool discovery and actual page creation passed. Enable `mcp-chrome-devtools` when performance/debugging tools are needed. Playwright remains the default browser controller. Usage statistics disabled.                                                                                          |
| DeepWiki MCP                  | Configured, disabled                    | Endpoint initialization responded, but tool discovery repeatedly timed out with the current client/network. Alternative transport and proxy probes did not resolve it. Temporary `mcp-remote` dependency removed. Re-test before enabling `mcp-deepwiki`.                                        |
| GitHub MCP                    | Read-only endpoint configured, disabled | Authentication not configured or tested. Enable only after adding authentication through the supported credential mechanism.                                                                                                                                                                     |
| Existing Lark bridge `0.0.10` | Preserved, disabled                     | Incompatible with the new settings API (`deepEqualJson` import and old `settings.register` usage). Its original local tarball was recovered with matching integrity and stored under `~/.dsh/plugin-artifacts/`. Migration is still required; registry latest was older and was not substituted. |

## Development experience choices

- Reuse installed Chrome instead of downloading another browser distribution.
- Use explicit TypeScript and Rust analyzer paths so LSP works outside a repository with a pinned toolchain. These paths must be updated if the NVM Node installation or Rust toolchain is removed.
- Keep normal workspace permissions. No automatic approval bypass or external notification destinations were added.
- Context/cost plugins may query the existing DeepSeek account and external pricing/update sources; these plugins are not entirely offline. Existing host model/telemetry settings were retained.
- Keep one default browser controller, one MCP implementation and one primary cost meter.
- Defer overlapping skill bundles, extra memory/index services, old-host-only plugins, and bundled Codex delegation. The latter installs another Codex runtime, while available disk space was approximately 1.4 GiB during setup. See research for sources and exclusions.

## Verification evidence and limits

Private evidence directory: `/Users/bytedance/.dsh-backups/2026-10-04T125834+0800/plugin-setup/`.

- `dsh --version`: `0.2.0-rc.2`.
- Web and TUI `--dump-config`: exit 0, no stderr.
- `runtime-verification.json`: TypeScript definition PASS; Rust hover PASS; LSP, repo setup, Context7 and Playwright tool registration PASS.
- `mcp-tools.json`, `mcp-behavior.json`: Context7, Playwright and Chrome DevTools discovery and functional calls; DeepWiki failure recorded separately.
- `web-loader.json`, `tui-loader.json`: host component states. Context7 was still connecting at the early snapshot and registered successfully in the later runtime probe.
- `tui-smoke.raw`: real terminal output rendered (4,821 bytes). The test process was terminated after capture.
- Web browser checks: plugin inventory, populated prompt templates, session list, artifact panel and marketplace tabs rendered.
- No paid model-completion request was submitted. UI mounting and tool probes do not establish every plugin's end-to-end model workflow.
- Temporary verifier modules were passed only with `--patch`; they are absent from permanent profile configuration. Temporary test servers and browser sessions are closed after verification.

## Backup and recovery

- Pre-upgrade archive: `/Users/bytedance/.dsh-backups/2026-10-04T125834+0800/before-upgrade.tar.gz`.
- Pre-plugin configuration: `plugin-setup/before-plugins-config.tar.gz` under the same directory.
- Archives contain private configuration and must remain private. No credential values are reproduced in this report.
- New-host settings/credential migration occurred; preserve these archives before any downgrade. Do not overlay an old archive on a live profile. Stop DSH, inspect the archive, and restore into a separate recovery directory/profile first.
- To disable an added runtime component reversibly, set its existing row to `disabled: true` in `~/.dsh/profiles/web/cordis.patch.yml`, then restart DSH. Direct versions are recorded in `package.json` and the profile lockfile.

## Sources

- [Official DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 0.2.0-rc.2 release metadata](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.0-rc.2)
- [Plugin marketplace maintainer](https://github.com/dsh-market/dsh-market)
- [Official Context7](https://github.com/upstash/context7)
- [Official Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Official Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [DeepWiki MCP documentation](https://docs.devin.ai/work-with-devin/deepwiki-mcp)
- [Detailed package-by-package research and exclusions](2026-10-04-deepseek-harness-plugin-shortlist.md)

## UI and sidebar expansion — 2026-10-04

The subsequent user request added beautification, both sidebars, and more useful features. Research compared three awesome lists and then verified package source; see [UI research](2026-10-04-deepseek-harness-ui-plugin-research.md).

| Added package                 | Applied behavior                                                                                                                                                                                                             | Verification                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-better-sidebar@0.24.1`   | Native right-sidebar workbench: editable file previews, file tree, Git changes, tasks, bottom panel and optional side chat. Editor explorer enabled; automatic jobs/subagent pop-open disabled; tasks default to tree.       | Host ACTIVE, no missing services; actual Cognia file tree and Markdown report preview opened, editor controls rendered. No Git commit, file save, or side-chat model run was performed.             |
| `dsh-better-workspace@0.27.1` | Left workspace/session hierarchy, directory/name grouping, search, icons/colors and sorting controls. Compact chains enabled, status pulse off, regular font, glow/shadow/outline off. Test-browser session limit set to 10. | Host ACTIVE; workspace/session tree and appearance settings opened; DOM check found no text outline after configuration. Existing workspace names and session titles were not manually reorganized. |
| `dsh-theme-plugin@0.3.3`      | 98 traditional-color light/dark themes, with themed code colors. Built-in host text size set to 15px and appearance set to system.                                                                                           | Host ACTIVE; `zhuqing-light` applied in the test browser, expected background token rendered and selection survived reload.                                                                         |
| `dsh-view-manager@0.2.1`      | Enable/hide, reorder and rename session view tabs.                                                                                                                                                                           | Host ACTIVE; populated Chat/Trajectory/Artifacts/Context management controls opened. Default tab order retained.                                                                                    |
| `dsh-file-mentions@1.2.2`     | Clickable file paths and reveal/open actions in replies; empty external-root allowlist.                                                                                                                                      | Host ACTIVE; File Mentions settings mounted. No OS application-launch action or synthetic model reply was used.                                                                                     |

File Mentions is pinned to the maintainer commit `b3b85770ee8439eee719accfc9b42676d66b15b3` through an immutable codeload URL. Other additions use exact npm versions.

### Browser-local appearance

Theme selections, view-tab customization and some workspace preferences are browser/origin-local. The preview browser is separate from the user's everyday browser; its theme choice must not be reported as globally applied. In the user's browser, open **Settings → Color Themes** and choose **Zhu Qing Light / 竹青** (or a dark palette). The plugin's README calls this section Traditional Colors; the currently rendered English label is Color Themes. The host's 15px font setting is profile-persistent. Workspace appearance values were also written to the profile; browser-local copies can need manual synchronization/reselection.

### Rejected or disabled candidates

- `dsh-split-screen@1.2.6` was installed, tested, then disabled. Its empty-session overlay covered native controls, and Add current conversation did not recover that view. It remains installed only for possible later compatibility re-testing; do not enable it as part of the working baseline.
- `dsh-smooth-stream@0.6.1` was not installed: published host code unconditionally calls removed `settings.register`.
- Spotlight's published release still uses an old navigation API. Question Navigator's full-height right overlay conflicts with the workbench. Old premium-theme packages, a second terminal and separate diff-view overrides were not added. Details and owning sources are in the research report.

### Evidence and recovery

- Final composition: `dsh --profile web --dump-config`, exit 0, no stderr.
- All five enabled addition rows: state 2 (ACTIVE), no missing services; split-screen disabled.
- Final browser error capture was empty. This is UI mounting/navigation evidence, not exhaustive plugin correctness or a completed paid model task.
- Backup and evidence: `/Users/bytedance/.dsh-backups/2026-10-04-ui-plugins/` (`before-ui-config.tar.gz`, `web-loader.json`, `verification.json`, `ui-preview.png`).
- Temporary verification overlays are outside the permanent profile. Temporary server/browser sessions are stopped at task completion.
- The profile has not been committed to the application repository; only the research/setup documents were added or updated there.

## Sidebar readability repair and user wallpaper — 2026-10-04

The user's screenshot exposed an incomplete cross-browser result from the previous pass: Better Workspace's browser-local appearance still defaulted to a gray outline, even though the profile held `stroke:false` and the test browser had been changed. Its 1px setting emits a 2px CSS text stroke, making small labels look blurred. The previous per-browser verification did not establish the user's browser state.

A small profile-local host plugin at `~/.dsh/local-plugins/ui-readability.mjs` now injects a scoped stylesheet on every page: only `.bw-root` and its descendants get zero text-stroke width and no text shadow. This overrides stale browser-local inline appearance values without changing workspace names, hierarchy, colors or stored session data. Better Sidebar's existing custom-CSS hook was considered, but it depends on its right-sidebar component's mount lifecycle; an unconditional page-level fix is needed for home and plugin pages too. The override is a separate local module, so npm updates do not overwrite it. Disable the `local-ui-readability` profile row to remove it.

Installed **`dsh-any-background@0.3.4`** for shared, filesystem-backed wallpaper and per-surface controls. The user's explicit image is `/Users/bytedance/Pictures/20260617-162616.jpg`; it was copied unchanged into `~/.dsh/.dsh-any-background-data/wallpaper.jpg`. No image generation, image editing or external upload was used. The source file remains unchanged.

Wallpaper configuration lives in `~/.dsh/.dsh-any-background-data/theme-config.json`: image/fill mode, wallpaper opacity 1, all background/panel blur values 0; sidebar opacity 0.9, input 0.95, settings 0.98, conversation surface 0.78. Custom theme color is unset, preserving the chosen color-theme owner. `dsh-wallpaper-bg` was briefly evaluated/installed and then removed when the user selected a local image: its upload store is browser-local IndexedDB, whereas the chosen plugin restores the same file across browsers. Its initial builtin-landscape seed was removed before the final configuration.

Verification:

- Wallpaper/readability host rows ACTIVE with no missing services.
- Fresh browser with untouched Better Workspace default preferences: labels computed to `0px` text stroke and `none` text shadow.
- Synthetic stale inline `2px gray` stroke plus glow remained overridden; original element style restored after the check.
- Reload retained the fix and wallpaper.
- Served wallpaper HTTP 200, SHA-256 `eed5570ec6cc1359691f8ab7c3df71bc3489987901f3eaf9bdcbe289242dee46`, exactly equal to the supplied JPG.
- No browser errors in final capture. Evidence and backup: `~/.dsh-backups/2026-10-04-wallpaper-fix/`, including `preview.png` and `verification.json`.
- The user's existing DSH server was left running. Refresh the user's page with Cmd+Shift+R; if its current process has not picked up the changed profile, restart `dsh web`.

Further additions are optional: the prepared GitHub MCP needs authentication, Chrome DevTools is available for performance work, and the preserved Lark bridge still needs compatibility repair. Existing file editing, Git views, LSP, docs/browser tools, templates, cost/context inspection and marketplace cover the main development workflow; no extra overlapping UI or memory plugins were added in this repair.

Sources: [Any Background maintainer](https://github.com/Tkingxiao/dsh-any-background), [exact release metadata](https://registry.npmjs.org/dsh-any-background/0.3.4), [Better Workspace source](https://github.com/KannaKuron/dsh-better-workspace).

## Better Workspace removed — 2026-10-04

At the user’s request, uninstalled `dsh-better-workspace` from the Web profile and removed its configuration row. Removed the now-unused `local-ui-readability` override, preserving a copy under `~/.dsh-backups/remove-better-workspace-20261004T141034/`. Final composition succeeds and contains neither entry. Native left-sidebar behavior resumes after reload; Better Sidebar and the user-selected wallpaper remain installed.

## Additional plugins installed — 2026-10-04

At the user's request to install compatible recommendations, tested all six candidates against DSH `0.2.0-rc.2`. Retained five pinned packages:

| Plugin                          | Version  | Verified scope / limitation                                                                                                                                                                                                                                           |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@changfenhuang/dsh-annotation` | `1.4.11` | Real assistant text selection opened Annotate; saved a local pending annotation and verified its numbered marker. Removed the test annotation. Model submission was not exercised.                                                                                    |
| `dsh-session-pin`               | `0.7.16` | Workspace pin/unpin controls toggled in the browser; test pin restored. Full grouping/tag/filter features not verified.                                                                                                                                               |
| `dsh-lsp-actions`               | `0.5.6`  | Configured existing TypeScript and Rust servers. Its registered diagnostics tool returned actual TypeScript TS2322 from a disposable fixture. Rename/format writes and Rust diagnostics were not exercised.                                                           |
| `dsh-mcp-panel`                 | `0.6.19` | Chinese `/mcp` handler returned five configured servers and registered tool counts. The old settings tab does not mount on this host; retained for command functionality only. Connection status remains unknown because the expected upstream status seam is absent. |
| `@liustack/modlens`             | `3.26.5` | Host/browser loading passed, offline doctor completed. No vision API configured; installed Claude/Kimi binaries do not establish authentication or vision availability. No new cross-harness reuse grants or image/model requests made.                               |

`dsh-composer-history@0.8.7` loaded on the host but prevented the Web UI from booting (`web boot: 1 entry did not activate`, `dsh-composer-history: failed`). Uninstalled it and removed the temporary disabling row. No third-party package source was patched.

Profile backup and evidence: `/Users/bytedance/.dsh-backups/2026-10-04-plugin-additions-142741`. Includes original manifest/lockfile/patch, loader states, real diagnostic output, offline doctor report, and final composed config. The user wallpaper hash remains unchanged and Better Workspace remains absent. Restart `dsh web` if the existing process has not loaded the new packages, then refresh the browser.

Sources: [Annotation](https://github.com/omdsh-dev/dsh-annotation), [Session Pin](https://github.com/PerryLink/dsh-session-pin), [LSP Actions](https://github.com/PerryLink/dsh-lsp-actions), [MCP Panel](https://github.com/PerryLink/dsh-mcp-panel), [ModLens](https://github.com/liustack/modlens), [Composer History](https://github.com/PerryLink/dsh-composer-history).
