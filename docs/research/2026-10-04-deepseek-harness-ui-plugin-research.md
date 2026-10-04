# DeepSeek Harness UI plugin research — 2026-10-04

Target: DSH `0.2.0-rc.2`, macOS Apple Silicon, Node `26.5.0`. This is a source/registry review, not an installation or runtime-verification report. Registry versions were fetched on 2026-10-04. Package sizes below are npm unpacked bytes, excluding transitive dependencies.

## Selection method

Cross-checked three independent awesome lists, then followed candidates to their owning repositories and npm manifests. Lists are discovery aids; inclusion and popularity do not establish current host compatibility.

- [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness): broad ecosystem, native sidebar extensions, UI themes, navigation and developer tooling.
- [SihanTeng/awesome-deepseek-harness-plugins](https://github.com/SihanTeng/awesome-deepseek-harness-plugins): category-focused catalog including Web UI, orchestration, search, memory, and tools.
- [beancookie/awesome-dsh-plugin](https://github.com/beancookie/awesome-dsh-plugin/blob/main/README.en.md): useful complementary file-mention, workspace-kit, palette and diff candidates.

The coherent configuration is one theme owner, one right-sidebar workbench, optional view organization, and small complementary helpers. Installing several replacement renderers or independent sidebar overlays creates competing UI ownership.

## Prioritized candidates

| Candidate              | Exact current version | Package size           | Decision / evidence                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-better-sidebar`   | `0.24.1`              | 15,501,753 B           | Strong fit: native right-sidebar integration, editor, file tree, Git changes, tasks and side chat. Maintainer explicitly targets DSH 0.2.0-rc.1+. No node-pty dependency in this version; terminal ownership returns to host. Many CodeMirror/Mermaid dependencies. Parent handles install and UI validation. |
| `dsh-view-manager`     | `0.2.1`               | 50,429 B               | Small zero-runtime-dependency tab organization plugin. Parent reviews integration and actual UI.                                                                                                                                                                                                              |
| `dsh-file-mentions`    | Git package `1.2.2`   | Git-only; not measured | Best complementary addition. Bare backtick paths and reply-tail file chips; leaves native links and composer references alone. Exact DSH 0.2.0-rc.2 compatibility declaration and migrated Config API.                                                                                                        |
| `dsh-better-workspace` | `0.27.1`              | 606,526 B              | Strong left-sidebar candidate: nested workspaces/sessions, colors/icons, search and drag ordering. Zero runtime dependencies. Config migration confirmed; legacy settings.register is guarded and skipped on new host. Real UI validation remains required.                                                   |
| `dsh-catppuccin`       | `0.2.3`               | 158,706 B              | Zero dependency alternative theme, but host peer declarations remain 0.1.0-rc.6. Avoid stacking with the chosen theme.                                                                                                                                                                                        |
| `dsh-appearance`       | `0.2.0`               | 73,620 B               | npm is ahead of Git source version 0.1.0. Theme/font coordinator; duplicates chosen theme ownership. Do not infer current npm behavior from stale Git README.                                                                                                                                                 |

Primary manifests: [sidebar](https://registry.npmjs.org/dsh-better-sidebar/0.24.1), [view manager](https://registry.npmjs.org/dsh-view-manager/0.2.1), [workspace](https://registry.npmjs.org/dsh-better-workspace/0.27.1), [Catppuccin](https://registry.npmjs.org/dsh-catppuccin/0.2.3), [appearance](https://registry.npmjs.org/dsh-appearance/0.2.0). Sidebar compatibility and behavior: [maintainer README](https://github.com/omdsh-dev/DSH-better-sidebar).

## File mentions: precise installation and behavior

Use pinned source `github:a903067276-rgb/dsh-file-mentions#b3b85770ee8439eee719accfc9b42676d66b15b3`. npm under the unscoped name returns 404; this is intentionally a Git-distributed plugin. The repository commits prebuilt `lib/`, declares no runtime dependencies, and has no install/prepare lifecycle. The bundle inserts row `file-mentions`.

Recommended config is the native default `extraProbeRoots: []`. The plugin already permits probes within the session cwd and user home. Adding external volumes is unnecessary for the current request. Host `Config` exports a volatile schema; source explicitly replaces the removed `settings.register/get` API.

The client skips native anchor/button/pre elements, so existing file links and sidebar navigation retain their owner. Clicking an eligible bare path invokes its local API, which uses `execFile` with an argument array for macOS `open`/`open -R`; there is no shell interpolation. It does not edit the referenced files. The settings route changes plugin configuration only after a user settings action. Its localhost Origin/Host check is a local-origin allowlist, not a strict equality comparison with the request Host; do not describe it as a comprehensive security audit.

Sources: [pinned manifest](https://github.com/a903067276-rgb/dsh-file-mentions/blob/b3b85770ee8439eee719accfc9b42676d66b15b3/package.json), [host implementation](https://github.com/a903067276-rgb/dsh-file-mentions/blob/b3b85770ee8439eee719accfc9b42676d66b15b3/lib/index.js), [client implementation](https://github.com/a903067276-rgb/dsh-file-mentions/blob/b3b85770ee8439eee719accfc9b42676d66b15b3/lib/client.js).

## Candidates deliberately deferred

| Candidate                                         | Finding                                                                                       | Reason to defer                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@known-mouse/dsh-history-question-nav@1.0.0`     | 15,295 B; zero dependencies; current-session question list                                    | Fixed full-height right overlay (`right:0`, z-index 60), initially expanded. It would cover the native/better sidebar. No native tab integration in reviewed source. |
| `@0xsline/dsh-spotlight@0.0.2`                    | 104,210 B; npm host imports unscoped `schemastery`; client navigates via `host.sessions.open` | Published npm build uses old navigation API removed in newer host versions. Source main differs from npm peer names. Do not install based solely on README.          |
| `@deepseek-ai/dsh-client-ui-premium-themes@0.1.0` | Repository uses master, not main; Git-only availability not fully resolved                    | Declares runtime `@deepseek-ai/dsh-settings ^0.1.0-rc.6` and old host peers; duplicates theme control. The scoped name does not itself establish official ownership. |
| `@dsh-external/dsh-diff-viewer@0.2.0`             | Git master `df5f55f721ed5a878767e2dd7e85616785a2ee11`; private npm package                    | Replaces write/edit tool-view slots and adds Shiki4/diff8. Sidebar already supplies useful diff review; optional later after interaction checks.                     |
| `dsh-workspace-kit@0.1.12`                        | 369,899 B, zero deps; explicit host engine `^0.1.2-rc.1`                                      | Replaces left workspace browser and cmd+K; version range excludes target minor. Do not stack with another workspace replacement.                                     |
| `dsh-better-model-selector@1.0.0`                 | 35,170 B, zero deps                                                                           | Host peers still `^0.1.0-rc.6`; replaces native selector and shortcuts. No validated need beyond native controls.                                                    |
| `dsh-terminal@0.1.1`                              | 896,108 B plus node-pty native dependency                                                     | Host and sidebar already provide terminal access; duplicate native dependency unnecessary.                                                                           |
| `dsh-launch@0.2.0`                                | 118,708 B; persistent service supervisor                                                      | Peers bind better-sidebar 0.11/0.12 and host0.1.0; current sidebar0.24 is outside range.                                                                             |
| `dsh-web-search-pro@0.1.15`                       | 605,569 B plus dependencies                                                                   | Pins many host peers exactly 0.1.7-rc.2; target is 0.2.0-rc.2.                                                                                                       |

Sources: [question navigator](https://github.com/TropicWiden/dsh-history-question-nav), [Spotlight](https://github.com/0xsline/dsh-spotlight), [npm Spotlight](https://registry.npmjs.org/@0xsline/dsh-spotlight/0.0.2), [premium themes](https://github.com/xiaoyanzi191/dsh-premium-themes/tree/master), [diff viewer](https://github.com/lehhair/dsh-diff-viewer/tree/master), [workspace kit](https://github.com/ice5kysl/dsh-workspace-kit), [model selector](https://registry.npmjs.org/dsh-better-model-selector/1.0.0), [terminal](https://registry.npmjs.org/dsh-terminal/0.1.1), [launch](https://registry.npmjs.org/dsh-launch/0.2.0), [search-pro](https://registry.npmjs.org/dsh-web-search-pro/0.1.15).

## Additional feature candidate

`dsh-free-search@0.7.3` (349,066 B plus Schemastery) explicitly allows host 0.2.0-rc.1 peers and has migrated to profile Config. It supplies search-engine selection and public platform search. However its fallback chain can use configured paid providers, and it changes the default provider at runtime when unset/official. If later enabled, explicitly constrain engines to the intended public/free set and test network behavior; do not call the whole plugin cost-free merely because of its name. This is separate from visual/sidebar improvements.

Sources: [npm manifest](https://registry.npmjs.org/dsh-free-search/0.7.3), [maintainer source](https://github.com/DDDMUC/dsh-free-search).

## Verification required by installer

Confirm active host loader entries and browser-side activation, open sidebar files and an isolated fixture diff, switch the chosen theme and refresh, test view navigation, and verify file-mention existence checks on a disposable fixture. Do not rename, move, delete, stage, commit, or archive the user’s existing content as a smoke test. Record installed versions separately from source-review candidates and state any untested interactive paths.

## Better workspace configuration confirmed

The `0.27.1` package uses `src/index.js` as its host entry. It exports volatile `Config` fields `compactChains`, `statusPulse`, `styling`, and `appearance`; the legacy `settings.register` path is protected by a function-existence check and does not run on the new host. Bundle row is `better-workspace`.

For a restrained developer UI, use:

```yaml
- id: better-workspace
  config:
    compactChains: true
    statusPulse: false
    styling: {}
    appearance:
      color: ""
      glow: 0
      weight: 0
      shadow: false
      stroke: false
```

The client defaults font stroke to true, so `stroke:false` is intentional. `autoStyle` is a separate browser preference, defaults false, and is not part of host Config. Fresh installs preserve disk-path workspace nesting; name-based workspace grouping is opt-in. Session grouping by slash defaults on, and row limit defaults unlimited. The plugin automatically quotes newly generated slash-containing session titles after settling; its source excludes historical and manually assigned titles. Dragging/renaming groups can rename stored workspace/session titles, so smoke tests should exercise display/search only.

Primary sources: [host entry](https://github.com/KannaKuron/dsh-better-workspace/blob/main/src/index.js), [client](https://github.com/KannaKuron/dsh-better-workspace/blob/main/src/client.js), [registry pinned package](https://registry.npmjs.org/dsh-better-workspace/0.27.1). Source review used the actual published 0.27.1 tarball.
