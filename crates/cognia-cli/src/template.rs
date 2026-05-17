//! Bundled plugin templates — files emitted by `cognia plugin new`.
//!
//! Stored as `include_str!` blobs so the CLI binary is self-contained
//! (no separate templates directory shipped alongside it). Two kinds
//! ship today: `wasm` (the existing Rust + cargo-component scaffold) and
//! `ts` (TypeScript frontend plugin scaffold).

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// Which starter to stamp into a new directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateKind {
    Wasm,
    Ts,
}

impl TemplateKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "wasm" => Ok(Self::Wasm),
            "ts" | "typescript" | "frontend" => Ok(Self::Ts),
            other => bail!("unknown template kind \"{other}\" — expected wasm or ts"),
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
    pub const PACKAGE_JSON: &str =
        include_str!("../../cognia-plugin-template-ts/package.json");
    pub const TSCONFIG_JSON: &str =
        include_str!("../../cognia-plugin-template-ts/tsconfig.json");
    pub const JEST_CONFIG: &str =
        include_str!("../../cognia-plugin-template-ts/jest.config.cjs");
    pub const PLUGIN_JSON: &str =
        include_str!("../../cognia-plugin-template-ts/plugin.json");
    pub const SRC_INDEX_TS: &str =
        include_str!("../../cognia-plugin-template-ts/src/index.ts");
    pub const SRC_INDEX_TEST_TS: &str =
        include_str!("../../cognia-plugin-template-ts/src/index.test.ts");
    pub const SHIM_PLUGIN_TS: &str =
        include_str!("../../cognia-plugin-template-ts/src/__shims__/types/plugin.ts");
    pub const SHIM_SLASH_TS: &str = include_str!(
        "../../cognia-plugin-template-ts/src/__shims__/lib/chat/slash-command-registry.ts"
    );
    pub const GITIGNORE: &str =
        include_str!("../../cognia-plugin-template-ts/.gitignore");
    pub const README: &str = include_str!("../../cognia-plugin-template-ts/README.md");
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
    }
}

/// "Next steps" hint printed after `new` so authors know what to run next.
pub fn next_steps(kind: TemplateKind, target_dir: &Path) -> Vec<String> {
    match kind {
        TemplateKind::Wasm => vec![
            format!("cd {}", target_dir.display()),
            "rustup target add wasm32-wasip2".into(),
            "cargo install --locked cargo-component".into(),
            "cognia plugin build".into(),
        ],
        TemplateKind::Ts => vec![
            format!("cd {}", target_dir.display()),
            "pnpm install   # (or npm install / yarn install)".into(),
            "pnpm test      # the template's jest tests should all pass".into(),
            "cognia plugin lint".into(),
            "cognia plugin build".into(),
        ],
    }
}

// ── Name substitution ───────────────────────────────────────────────────────

fn substitute_wasm_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template", target_name)
        .replace("Cognia Plugin Template", &humanize(target_name))
}

fn substitute_ts_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template-ts", target_name)
        .replace("Cognia Plugin Template TS", &humanize(target_name))
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
        assert!(TemplateKind::parse("python").is_err());
    }

    #[test]
    fn wasm_template_files_are_non_empty() {
        let files = files_for(TemplateKind::Wasm, "my-plugin");
        assert!(!files.is_empty());
        for f in &files {
            assert!(!f.content.is_empty(), "{} should not be empty", f.rel_path.display());
        }
        let cargo = files.iter().find(|f| f.rel_path == PathBuf::from("Cargo.toml")).unwrap();
        assert!(cargo.content.contains(r#"name = "my-plugin""#));
        let pj = files.iter().find(|f| f.rel_path == PathBuf::from("plugin.json")).unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
    }

    #[test]
    fn ts_template_files_are_non_empty() {
        let files = files_for(TemplateKind::Ts, "my-plugin");
        assert!(files.len() >= 8);
        let names: Vec<_> = files.iter().map(|f| f.rel_path.to_string_lossy().to_string()).collect();
        assert!(names.iter().any(|n| n == "package.json"));
        assert!(names.iter().any(|n| n.ends_with("index.ts")));
        assert!(names.iter().any(|n| n.ends_with("index.test.ts")));
        let pj = files.iter().find(|f| f.rel_path == PathBuf::from("plugin.json")).unwrap();
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        let pkg = files.iter().find(|f| f.rel_path == PathBuf::from("package.json")).unwrap();
        assert!(pkg.content.contains(r#""name": "my-plugin""#));
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
    fn next_steps_includes_cargo_for_wasm() {
        let steps = next_steps(TemplateKind::Wasm, Path::new("/tmp/x"));
        assert!(steps.iter().any(|s| s.contains("cargo-component")));
        assert!(steps.iter().any(|s| s.contains("cognia plugin build")));
    }
}
