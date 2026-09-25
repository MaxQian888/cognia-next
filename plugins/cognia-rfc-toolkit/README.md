# cognia-rfc-toolkit

Structured technical-design (RFC) skills for Cognia agents. The plugin ships three `local-bundle` skills that work together:

- **RFC: write a design plan** (`rfc-write-plan`) — plans a bug fix, new feature, or refactor by loading a task-type-specific guide and output template, researching the codebase, and writing a precise design document to a user-specified path.
- **RFC: critique a proposal** (`rfc-reflect`) — critiques a proposal draft along five dimensions (completeness, knowledge sufficiency, knowledge correctness, clarity/feasibility, output format) before it is written out.
- **Mermaid diagrams** (`mermaid-visualizer`) — produces syntactically valid Mermaid diagrams with clean layout; `rfc-write-plan` defers to it for every diagram block.

Ported from the aiden-plugins `arch` bundle with vendor-specific tooling (internal search tools, generated-code references, org templates) removed. The mechanism is fully generic: it only assumes standard file tools plus `${COGNIA_PLUGIN_ROOT}` for loading its own reference files.

## Install

This plugin is **not bundled** with the app — build it and install it into the desktop app. From the repository root (after `pnpm install`, which provides the `esbuild` the CLI runs):

```bash
# One-time: build the plugin-author CLI (or use a released `cognia` binary).
cargo install --locked --path crates/cognia-cli

# Compile src/index.ts to dist/index.js (the manifest's `main`) and pack
# plugins/cognia-rfc-toolkit/target/cognia/cognia-rfc-toolkit-0.1.0.zip
cognia plugin build --path plugins/cognia-rfc-toolkit

# Install into the running desktop app over the CLI bridge…
cognia plugin install plugins/cognia-rfc-toolkit/target/cognia/cognia-rfc-toolkit-0.1.0.zip
```

…or open the desktop app's **Plugins** panel, choose the local `.zip` install action, and pick that ZIP. `dist/` and `target/` are build output and are not checked in.

Then enable **RFC Toolkit** on the Plugins page and turn a skill on for a conversation from the chat composer's skill picker (type `@skill:`).

## When to use / not use

- Use when the user asks for a technical proposal, design doc, RFC, or structured implementation plan.
- Do not use for direct code changes (the skills produce documents, not implementations), for repository-specific proposal workflows already provided by project skills, or where a simpler plan-mode answer suffices.

## Platform support

`local-bundle` skills are read through the desktop filesystem bridge, so the plugin is desktop (`tauri`) only; it is marked `blocked` for browser and mobile runtimes.
