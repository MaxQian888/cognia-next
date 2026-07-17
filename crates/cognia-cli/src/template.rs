//! Bundled plugin templates — files emitted by `cognia plugin new`.
//!
//! Stored as `include_str!` blobs so the CLI binary is self-contained
//! (no separate templates directory shipped alongside it). Three kinds
//! ship today: `wasm` (Rust + cargo-component), `ts` (TypeScript frontend),
//! `python` (Python SDK entrypoint), `hybrid` (frontend + Python), and
//! `vscode-extension` (Node sidecar VS Code extension entrypoint).

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// Which starter to stamp into a new directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateKind {
    Wasm,
    Ts,
    Python,
    Hybrid,
    VscodeExtension,
}

impl TemplateKind {
    /// Every template kind — the exhaustive list for cross-template
    /// invariants. Test-only today (only the `.gitignore` invariant iterates
    /// it); un-gate when a production caller needs it.
    #[cfg(test)]
    const ALL: [TemplateKind; 5] = [
        Self::Wasm,
        Self::Ts,
        Self::Python,
        Self::Hybrid,
        Self::VscodeExtension,
    ];

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "wasm" => Ok(Self::Wasm),
            "ts" | "typescript" | "frontend" => Ok(Self::Ts),
            "py" | "python" => Ok(Self::Python),
            "hybrid" => Ok(Self::Hybrid),
            "vscode" | "vs-code" | "vscode-extension" => Ok(Self::VscodeExtension),
            other => bail!(
                "unknown template kind \"{other}\" — expected wasm, ts, python, hybrid, or vscode-extension"
            ),
        }
    }
}

// ── WASM template files (existing) ──────────────────────────────────────────
pub mod wasm {
    pub const CARGO_TOML: &str = include_str!("../../cognia-plugin-template/Cargo.toml");
    pub const SRC_LIB_RS: &str = include_str!("../../cognia-plugin-template/src/lib.rs");
    pub const PLUGIN_JSON: &str = include_str!("../../cognia-plugin-template/plugin.json");
    pub const WIT_WORLD: &str = include_str!("../../cognia-plugin-template/wit/world.wit");
    pub const README: &str = include_str!("../../cognia-plugin-template/README.md");
    pub const GITIGNORE: &str = include_str!("../../cognia-plugin-template/.gitignore");
}

// ── TS template files (new) ─────────────────────────────────────────────────
pub mod ts {
    pub const PACKAGE_JSON: &str = include_str!("../../cognia-plugin-template-ts/package.json");
    pub const TSCONFIG_JSON: &str = include_str!("../../cognia-plugin-template-ts/tsconfig.json");
    pub const JEST_CONFIG: &str = include_str!("../../cognia-plugin-template-ts/jest.config.cjs");
    pub const PLUGIN_JSON: &str = include_str!("../../cognia-plugin-template-ts/plugin.json");
    pub const SRC_INDEX_TS: &str = include_str!("../../cognia-plugin-template-ts/src/index.ts");
    pub const SRC_INDEX_TEST_TS: &str =
        include_str!("../../cognia-plugin-template-ts/src/index.test.ts");
    pub const SHIM_PLUGIN_TS: &str =
        include_str!("../../cognia-plugin-template-ts/src/__shims__/types/plugin.ts");
    pub const SHIM_SLASH_TS: &str = include_str!(
        "../../cognia-plugin-template-ts/src/__shims__/lib/chat/slash-command-registry.ts"
    );
    pub const GITIGNORE: &str = include_str!("../../cognia-plugin-template-ts/.gitignore");
    pub const README: &str = include_str!("../../cognia-plugin-template-ts/README.md");
}

// ── Python template files ──────────────────────────────────────────────────
pub mod python {
    pub const PLUGIN_JSON: &str = include_str!("../../cognia-plugin-template-python/plugin.json");
    pub const MAIN_PY: &str = include_str!("../../cognia-plugin-template-python/main.py");
    pub const README: &str = include_str!("../../cognia-plugin-template-python/README.md");
    pub const GITIGNORE: &str = include_str!("../../cognia-plugin-template-python/.gitignore");
}

// ── Hybrid template files ──────────────────────────────────────────────────
pub mod hybrid {
    pub const PLUGIN_JSON: &str = include_str!("../../cognia-plugin-template-hybrid/plugin.json");
    pub const FRONTEND_INDEX_JS: &str =
        include_str!("../../cognia-plugin-template-hybrid/frontend/index.js");
    pub const BACKEND_MAIN_PY: &str =
        include_str!("../../cognia-plugin-template-hybrid/backend/main.py");
    pub const STYLES: &str = include_str!("../../cognia-plugin-template-hybrid/styles.css");
    pub const README: &str = include_str!("../../cognia-plugin-template-hybrid/README.md");
    pub const GITIGNORE: &str = include_str!("../../cognia-plugin-template-hybrid/.gitignore");
}

// ── VS Code extension template files ───────────────────────────────────────
pub mod vscode_extension {
    pub const PLUGIN_JSON: &str =
        include_str!("../../cognia-plugin-template-vscode-extension/plugin.json");
    pub const PACKAGE_JSON: &str =
        include_str!("../../cognia-plugin-template-vscode-extension/package.json");
    pub const EXTENSION_JS: &str =
        include_str!("../../cognia-plugin-template-vscode-extension/extension/out/extension.js");
    pub const STYLES: &str =
        include_str!("../../cognia-plugin-template-vscode-extension/styles.css");
    pub const README: &str =
        include_str!("../../cognia-plugin-template-vscode-extension/README.md");
    pub const GITIGNORE: &str =
        include_str!("../../cognia-plugin-template-vscode-extension/.gitignore");
}

/// A file to write during template stamping, with its destination
/// (relative to the target dir) and its content.
pub struct TemplateFile {
    pub rel_path: PathBuf,
    pub content: String,
}

/// Materialize the full list of files for a given kind, with the
/// plugin name substituted into Cargo.toml / plugin.json / package.json
/// where appropriate.
pub fn files_for(kind: TemplateKind, plugin_name: &str) -> Vec<TemplateFile> {
    match kind {
        TemplateKind::Wasm => vec![
            TemplateFile {
                rel_path: PathBuf::from("Cargo.toml"),
                content: substitute_wasm_name(wasm::CARGO_TOML, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("src").join("lib.rs"),
                content: substitute_wasm_name(wasm::SRC_LIB_RS, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("plugin.json"),
                content: substitute_wasm_name(wasm::PLUGIN_JSON, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("wit").join("world.wit"),
                content: wasm::WIT_WORLD.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("README.md"),
                content: wasm::README.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from(".gitignore"),
                content: wasm::GITIGNORE.into(),
            },
        ],
        TemplateKind::Ts => vec![
            TemplateFile {
                rel_path: PathBuf::from("package.json"),
                content: substitute_ts_name(ts::PACKAGE_JSON, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("tsconfig.json"),
                content: ts::TSCONFIG_JSON.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("jest.config.cjs"),
                content: ts::JEST_CONFIG.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("plugin.json"),
                content: substitute_ts_name(ts::PLUGIN_JSON, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("src").join("index.ts"),
                content: substitute_ts_name(ts::SRC_INDEX_TS, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("src").join("index.test.ts"),
                content: substitute_ts_name(ts::SRC_INDEX_TEST_TS, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("src")
                    .join("__shims__")
                    .join("types")
                    .join("plugin.ts"),
                content: ts::SHIM_PLUGIN_TS.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("src")
                    .join("__shims__")
                    .join("lib")
                    .join("chat")
                    .join("slash-command-registry.ts"),
                content: ts::SHIM_SLASH_TS.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from(".gitignore"),
                content: ts::GITIGNORE.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("README.md"),
                content: ts::README.into(),
            },
        ],
        TemplateKind::Python => vec![
            TemplateFile {
                rel_path: PathBuf::from("plugin.json"),
                content: substitute_python_name(python::PLUGIN_JSON, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("main.py"),
                content: substitute_python_name(python::MAIN_PY, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from(".gitignore"),
                content: python::GITIGNORE.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("README.md"),
                content: python::README.into(),
            },
        ],
        TemplateKind::Hybrid => vec![
            TemplateFile {
                rel_path: PathBuf::from("plugin.json"),
                content: substitute_hybrid_name(hybrid::PLUGIN_JSON, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("frontend").join("index.js"),
                content: substitute_hybrid_name(hybrid::FRONTEND_INDEX_JS, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("backend").join("main.py"),
                content: substitute_hybrid_name(hybrid::BACKEND_MAIN_PY, plugin_name),
            },
            TemplateFile {
                rel_path: PathBuf::from("styles.css"),
                content: hybrid::STYLES.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from(".gitignore"),
                content: hybrid::GITIGNORE.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("README.md"),
                content: hybrid::README.into(),
            },
        ],
        TemplateKind::VscodeExtension => vec![
            TemplateFile {
                rel_path: PathBuf::from("plugin.json"),
                content: substitute_vscode_extension_name(
                    vscode_extension::PLUGIN_JSON,
                    plugin_name,
                ),
            },
            TemplateFile {
                rel_path: PathBuf::from("package.json"),
                content: substitute_vscode_extension_name(
                    vscode_extension::PACKAGE_JSON,
                    plugin_name,
                ),
            },
            TemplateFile {
                rel_path: PathBuf::from("extension").join("out").join("extension.js"),
                content: substitute_vscode_extension_name(
                    vscode_extension::EXTENSION_JS,
                    plugin_name,
                ),
            },
            TemplateFile {
                rel_path: PathBuf::from("styles.css"),
                content: vscode_extension::STYLES.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from(".gitignore"),
                content: vscode_extension::GITIGNORE.into(),
            },
            TemplateFile {
                rel_path: PathBuf::from("README.md"),
                content: vscode_extension::README.into(),
            },
        ],
    }
}

/// "Next steps" hint printed after `new` so authors know what to run next.
pub fn next_steps(kind: TemplateKind, target_dir: &Path) -> Vec<String> {
    let cd = format!("cd {}", target_dir.display());
    match kind {
        TemplateKind::Wasm => vec![
            cd,
            "rustup target add wasm32-wasip2".into(),
            "cargo install --locked cargo-component".into(),
            "cognia plugin doctor   # verify the toolchain is ready".into(),
            "cognia plugin lint".into(),
            "cognia plugin build".into(),
        ],
        TemplateKind::Ts => vec![
            cd,
            "pnpm install   # (or npm install / yarn install)".into(),
            "pnpm test      # the template's jest tests should all pass".into(),
            "cognia plugin doctor".into(),
            "cognia plugin lint".into(),
            "cognia plugin build".into(),
        ],
        TemplateKind::Python => vec![
            cd,
            "python -m py_compile main.py".into(),
            "cognia plugin doctor".into(),
            "cognia plugin lint".into(),
            "cognia plugin build".into(),
        ],
        TemplateKind::Hybrid => vec![
            cd,
            "node --check frontend/index.js".into(),
            "python -m py_compile backend/main.py".into(),
            "cognia plugin doctor".into(),
            "cognia plugin lint".into(),
            "cognia plugin build".into(),
        ],
        TemplateKind::VscodeExtension => vec![
            cd,
            "node --check extension/out/extension.js".into(),
            "cognia plugin doctor".into(),
            "cognia plugin lint".into(),
            "cognia plugin build".into(),
        ],
    }
}

// ── Name substitution ───────────────────────────────────────────────────────

fn substitute_wasm_name(content: &str, target_name: &str) -> String {
    content
        // The hyphenated package name must be replaced first: doing the
        // underscored pass first could let a `target_name` containing `_`
        // be re-substituted by the hyphenated pass.
        .replace("cognia-plugin-template", target_name)
        // cargo-component normalizes `-` → `_` in the emitted artifact name,
        // and `wasmMain` must name that artifact (e.g. `hello_wasm.wasm`),
        // not the hyphenated package name — otherwise `plugin build` can't
        // find the module by its declared name. wasm32-wasip2 applies the
        // same normalization inside the component itself.
        .replace("cognia_plugin_template", &target_name.replace('-', "_"))
        .replace("Cognia Plugin Template", &humanize(target_name))
}

fn substitute_ts_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template-ts", target_name)
        .replace("Cognia Plugin Template TS", &humanize(target_name))
}

fn substitute_python_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template-python", target_name)
        .replace("Cognia Plugin Template Python", &humanize(target_name))
}

fn substitute_hybrid_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template-hybrid", target_name)
        .replace("Cognia Plugin Template Hybrid", &humanize(target_name))
}

fn substitute_vscode_extension_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template-vscode-extension", target_name)
        .replace(
            "Cognia Plugin Template VS Code Extension",
            &humanize(target_name),
        )
}

fn humanize(name: &str) -> String {
    name.split(|c: char| c == '-' || c == '_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().chain(c).collect::<String>(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_known_kinds() {
        assert_eq!(TemplateKind::parse("wasm").unwrap(), TemplateKind::Wasm);
        assert_eq!(TemplateKind::parse("ts").unwrap(), TemplateKind::Ts);
        assert_eq!(TemplateKind::parse("typescript").unwrap(), TemplateKind::Ts);
        assert_eq!(TemplateKind::parse("frontend").unwrap(), TemplateKind::Ts);
        assert_eq!(TemplateKind::parse("python").unwrap(), TemplateKind::Python);
        assert_eq!(TemplateKind::parse("py").unwrap(), TemplateKind::Python);
        assert_eq!(TemplateKind::parse("hybrid").unwrap(), TemplateKind::Hybrid);
        assert_eq!(
            TemplateKind::parse("vscode-extension").unwrap(),
            TemplateKind::VscodeExtension
        );
        assert_eq!(
            TemplateKind::parse("vscode").unwrap(),
            TemplateKind::VscodeExtension
        );
    }

    #[test]
    fn every_template_gitignores_the_private_key_directory() {
        // `plugin new --with-keygen` writes the Ed25519 *private* key to
        // `.cognia/plugin.private.b64`. Every template must ignore that dir
        // or a first `git add -A` stages the signing key. The five templates
        // ship five independent `.gitignore`s with no shared floor, so pin
        // the invariant across all of them.
        for kind in TemplateKind::ALL {
            let files = files_for(kind, "probe");
            let gi = files
                .iter()
                .find(|f| f.rel_path == PathBuf::from(".gitignore"))
                .unwrap_or_else(|| panic!("{kind:?} template must ship a .gitignore"));
            assert!(
                gi.content.lines().any(|l| l.trim() == ".cognia/"),
                "{kind:?} template's .gitignore must ignore .cognia/ — \
                 `plugin new --with-keygen` writes the Ed25519 private key there"
            );
        }
    }

    #[test]
    fn wasm_template_files_are_non_empty() {
        let files = files_for(TemplateKind::Wasm, "my-plugin");
        assert!(!files.is_empty());
        for f in &files {
            assert!(
                !f.content.is_empty(),
                "{} should not be empty",
                f.rel_path.display()
            );
        }
        let cargo = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("Cargo.toml"))
            .unwrap();
        assert!(cargo.content.contains(r#"name = "my-plugin""#));
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
    }

    #[test]
    fn wasm_main_matches_cargo_component_normalized_artifact_name() {
        // cargo-component emits `<crate>.wasm` with `-` normalized to `_`,
        // so `wasmMain` must be the underscored artifact name — not the
        // hyphenated package name. Before the fix a scaffold named
        // `hello-wasm` shipped `wasmMain: "cognia_plugin_template.wasm"`.
        let files = files_for(TemplateKind::Wasm, "hello-wasm");
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        assert!(
            pj.content.contains(r#""wasmMain": "hello_wasm.wasm""#),
            "wasmMain should be the underscored artifact name, got:\n{}",
            pj.content
        );
        assert!(pj.content.contains(r#""id": "hello-wasm""#));
    }

    #[test]
    fn wasm_template_ships_a_live_capability() {
        // Working Rule 7: no dormant scaffolds. The wasm template's
        // `tool_execute` export must be backed by a declared `tools` capability
        // and a non-empty `tools[]` (matching ts/python/hybrid) — otherwise it
        // ships `capabilities: []` while its code implements a tool, which is a
        // latent bug the linter would rightly flag as dead weight.
        let files = files_for(TemplateKind::Wasm, "probe");
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        let m: serde_json::Value = serde_json::from_str(&pj.content).unwrap();
        let caps = m["capabilities"].as_array().expect("capabilities is an array");
        assert!(
            caps.iter().any(|c| c == "tools"),
            "wasm template must declare the `tools` capability its code implements, got: {caps:?}"
        );
        assert!(
            m["tools"].as_array().is_some_and(|t| !t.is_empty()),
            "wasm template must ship a non-empty tools[] so the capability isn't dormant"
        );
    }

    #[test]
    fn ts_template_files_are_non_empty() {
        let files = files_for(TemplateKind::Ts, "my-plugin");
        assert!(files.len() >= 8);
        let names: Vec<_> = files
            .iter()
            .map(|f| f.rel_path.to_string_lossy().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "package.json"));
        assert!(names.iter().any(|n| n.ends_with("index.ts")));
        assert!(names.iter().any(|n| n.ends_with("index.test.ts")));
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        let pkg = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("package.json"))
            .unwrap();
        assert!(pkg.content.contains(r#""name": "my-plugin""#));
    }

    #[test]
    fn python_template_files_are_non_empty() {
        let files = files_for(TemplateKind::Python, "my-plugin");
        let names: Vec<_> = files
            .iter()
            .map(|f| f.rel_path.to_string_lossy().to_string())
            .collect();
        for expected in ["plugin.json", "main.py", "README.md", ".gitignore"] {
            assert!(names.iter().any(|n| n == expected), "missing: {expected}");
        }
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        assert!(pj.content.contains(r#""type": "python""#));
        assert!(pj.content.contains(r#""pythonMain": "main.py""#));
        let main = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("main.py"))
            .unwrap();
        assert!(main.content.contains("from cognia import tool"));
        assert!(main.content.contains("template_echo"));
    }

    #[test]
    fn hybrid_template_files_are_non_empty() {
        let files = files_for(TemplateKind::Hybrid, "my-plugin");
        for expected in [
            "plugin.json",
            "frontend/index.js",
            "backend/main.py",
            "styles.css",
            "README.md",
            ".gitignore",
        ] {
            assert!(
                files.iter().any(|f| f.rel_path == PathBuf::from(expected)),
                "missing: {expected}"
            );
        }
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        assert!(pj.content.contains(r#""type": "hybrid""#));
        assert!(pj.content.contains(r#""main": "frontend/index.js""#));
        assert!(pj.content.contains(r#""pythonMain": "backend/main.py""#));
        assert!(pj.content.contains(r#""styles": "styles.css""#));
    }

    #[test]
    fn vscode_extension_template_files_are_non_empty() {
        let files = files_for(TemplateKind::VscodeExtension, "my-plugin");
        for expected in [
            "plugin.json",
            "package.json",
            "extension/out/extension.js",
            "styles.css",
            "README.md",
            ".gitignore",
        ] {
            assert!(
                files.iter().any(|f| f.rel_path == PathBuf::from(expected)),
                "missing: {expected}"
            );
        }
        let pj = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("plugin.json"))
            .unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        assert!(pj.content.contains(r#""type": "vscode-extension""#));
        assert!(pj
            .content
            .contains(r#""vscodeMain": "extension/out/extension.js""#));
        assert!(pj.content.contains(r#""styles": "styles.css""#));
        assert!(pj.content.contains(r#""bundle_include": ["package.json"]"#));
    }

    #[test]
    fn ts_tsconfig_paths_resolve_at_alias_to_shims() {
        // Regression: ts-jest type-checks `@/*` imports against tsconfig
        // `paths`. If `@/*` points at a nonexistent package the scaffold's
        // own `pnpm test` fails on a fresh `plugin new --kind ts` (TS2307),
        // contradicting the README + next-steps promise that tests are
        // green out of the box. The shims under src/__shims__ are the
        // resolution target the jest moduleNameMapper already uses.
        let cfg = ts::TSCONFIG_JSON;
        assert!(
            cfg.contains("./src/__shims__/*"),
            "tsconfig @/* should resolve to the bundled shims, got: {cfg}"
        );
        assert!(
            !cfg.contains("cognia-types"),
            "tsconfig must not point @/* at the nonexistent cognia-types package"
        );
    }

    #[test]
    fn humanize_handles_underscores_and_hyphens() {
        assert_eq!(humanize("my-cool-plugin"), "My Cool Plugin");
        assert_eq!(humanize("my_cool_plugin"), "My Cool Plugin");
        assert_eq!(humanize("plugin"), "Plugin");
        assert_eq!(humanize(""), "");
    }

    #[test]
    fn next_steps_includes_pnpm_for_ts() {
        let steps = next_steps(TemplateKind::Ts, Path::new("/tmp/x"));
        assert!(steps.iter().any(|s| s.contains("pnpm")));
        assert!(steps.iter().any(|s| s.contains("cognia plugin build")));
    }

    #[test]
    fn next_steps_includes_python_lint_and_build() {
        let steps = next_steps(TemplateKind::Python, Path::new("/tmp/x"));
        assert!(steps.iter().any(|s| s.contains("python")));
        assert!(steps.iter().any(|s| s.contains("cognia plugin lint")));
        assert!(steps.iter().any(|s| s.contains("cognia plugin build")));
    }

    #[test]
    fn next_steps_include_checks_for_hybrid_and_vscode_extension() {
        let hybrid_steps = next_steps(TemplateKind::Hybrid, Path::new("/tmp/x"));
        assert!(hybrid_steps.iter().any(|s| s.contains("node --check")));
        assert!(hybrid_steps.iter().any(|s| s.contains("python")));
        assert!(hybrid_steps
            .iter()
            .any(|s| s.contains("cognia plugin lint")));
        assert!(hybrid_steps
            .iter()
            .any(|s| s.contains("cognia plugin build")));

        let vscode_steps = next_steps(TemplateKind::VscodeExtension, Path::new("/tmp/x"));
        assert!(vscode_steps.iter().any(|s| s.contains("node --check")));
        assert!(vscode_steps
            .iter()
            .any(|s| s.contains("cognia plugin lint")));
        assert!(vscode_steps
            .iter()
            .any(|s| s.contains("cognia plugin build")));
    }

    #[test]
    fn next_steps_includes_cargo_for_wasm() {
        let steps = next_steps(TemplateKind::Wasm, Path::new("/tmp/x"));
        assert!(steps.iter().any(|s| s.contains("cargo-component")));
        assert!(steps.iter().any(|s| s.contains("cognia plugin build")));
        // Wasm previously skipped lint in its next-steps; it now includes it.
        assert!(steps.iter().any(|s| s.contains("cognia plugin lint")));
    }

    #[test]
    fn next_steps_mention_doctor_for_every_kind() {
        for kind in TemplateKind::ALL {
            let steps = next_steps(kind, Path::new("/tmp/x"));
            assert!(
                steps.iter().any(|s| s.contains("cognia plugin doctor")),
                "{kind:?} next-steps should point at doctor"
            );
        }
    }
}
