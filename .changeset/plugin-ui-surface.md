---
"cognia-next": minor
---

Third-party plugins can now ship React UI. Installed plugins previously could not: their bundles were built with `--external:react` while the loader's `require` threw for every specifier, so any plugin component crashed on its first hook. The loader now resolves a closed whitelist (`react`, its jsx runtimes, `@cognia/plugin-sdk`, and the new `@cognia/plugin-ui` component kit) from the host's own module graph, so plugins share one React and one set of components. `react-dom` is deliberately withheld, keeping contributions inside the slot they were mounted into.

`manifest.styles` also works for the first time — it was declared, packaged by the CLI, watched by `plugin dev`, and then silently dropped at runtime. Stylesheets are now injected wrapped in `@scope`, bounded to the contributing plugin's own subtree, with name-defining at-rules (`@keyframes`, `@font-face`, `@property`, `@counter-style`) hoisted back out since `@scope` cannot hold them.

Plugin UI gains the host's design system as a documented contract: `ThemeState` now reports applied motion, density, typography and radius, so JavaScript-driven animation can honour the user's reduce-motion preference (previously visible only to CSS, meaning plugin animations kept running after the user asked them to stop). Webviews get the same tokens injected, having previously inherited nothing. Each of the 57 UI extension points now declares a form factor, delivered to contributions as a prop, and slot wrappers are query containers so plugin CSS can use `@container`.

Also corrects the plugin authoring docs, which described a `surfaces[]` manifest field and a `ctx.api.extension.mount()` API that have never existed, and claimed the host loads plugins via dynamic `import()`.
