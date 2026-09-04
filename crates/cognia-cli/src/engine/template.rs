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
    pub const CARGO_TOML: &str = include_str!("../../../cognia-plugin-template/Cargo.toml");
    pub const SRC_LIB_RS: &str = include_str!("../../../cognia-plugin-template/src/lib.rs");
    pub const PLUGIN_JSON: &str = include_str!("../../../cognia-plugin-template/plugin.json");
    pub const WIT_WORLD: &str = include_str!("../../../cognia-plugin-template/wit/world.wit");
    pub const README: &str = include_str!("../../../cognia-plugin-template/README.md");
    pub const GITIGNORE: &str = include_str!("../../../cognia-plugin-template/.gitignore");
}

// ── TS template files (new) ─────────────────────────────────────────────────
pub mod ts {
    pub const PACKAGE_JSON: &str = include_str!("../../../cognia-plugin-template-ts/package.json");
    pub const TSCONFIG_JSON: &str =
        include_str!("../../../cognia-plugin-template-ts/tsconfig.json");
    pub const JEST_CONFIG: &str =
        include_str!("../../../cognia-plugin-template-ts/jest.config.cjs");
    pub const PLUGIN_JSON: &str = include_str!("../../../cognia-plugin-template-ts/plugin.json");
    pub const SRC_INDEX_TS: &str = include_str!("../../../cognia-plugin-template-ts/src/index.ts");
    pub const SRC_INDEX_TEST_TS: &str =
        include_str!("../../../cognia-plugin-template-ts/src/index.test.ts");
    // `src/index.ts` imports `./panel`, and `plugin.json` declares
    // `"styles": "src/panel.css"` — so all three ship or the scaffold is broken.
    pub const SRC_PANEL_TSX: &str =
        include_str!("../../../cognia-plugin-template-ts/src/panel.tsx");
    pub const SRC_PANEL_TEST_TSX: &str =
        include_str!("../../../cognia-plugin-template-ts/src/panel.test.tsx");
    pub const SRC_PANEL_CSS: &str =
        include_str!("../../../cognia-plugin-template-ts/src/panel.css");
    // Jest resolves `@cognia/*` for real, unlike tsc (paths) and esbuild
    // (external), so the scaffold ships stubs for it to land on.
    pub const SRC_STUB_SDK: &str =
        include_str!("../../../cognia-plugin-template-ts/src/__stubs__/plugin-sdk.ts");
    pub const SRC_STUB_UI: &str =
        include_str!("../../../cognia-plugin-template-ts/src/__stubs__/plugin-ui.tsx");
    pub const GITIGNORE: &str = include_str!("../../../cognia-plugin-template-ts/.gitignore");
    pub const README: &str = include_str!("../../../cognia-plugin-template-ts/README.md");
}

// ── Python template files ──────────────────────────────────────────────────
pub mod python {
    pub const PLUGIN_JSON: &str =
        include_str!("../../../cognia-plugin-template-python/plugin.json");
    pub const MAIN_PY: &str = include_str!("../../../cognia-plugin-template-python/main.py");
    pub const README: &str = include_str!("../../../cognia-plugin-template-python/README.md");
    pub const GITIGNORE: &str = include_str!("../../../cognia-plugin-template-python/.gitignore");
}

// ── Hybrid template files ──────────────────────────────────────────────────
pub mod hybrid {
    pub const PLUGIN_JSON: &str =
        include_str!("../../../cognia-plugin-template-hybrid/plugin.json");
    pub const FRONTEND_INDEX_JS: &str =
        include_str!("../../../cognia-plugin-template-hybrid/frontend/index.js");
    pub const BACKEND_MAIN_PY: &str =
        include_str!("../../../cognia-plugin-template-hybrid/backend/main.py");
    pub const STYLES: &str = include_str!("../../../cognia-plugin-template-hybrid/styles.css");
    pub const README: &str = include_str!("../../../cognia-plugin-template-hybrid/README.md");
    pub const GITIGNORE: &str = include_str!("../../../cognia-plugin-template-hybrid/.gitignore");
}

// ── VS Code extension template files ───────────────────────────────────────
pub mod vscode_extension {
    pub const PLUGIN_JSON: &str =
        include_str!("../../../cognia-plugin-template-vscode-extension/plugin.json");
    pub const PACKAGE_JSON: &str =
        include_str!("../../../cognia-plugin-template-vscode-extension/package.json");
    pub const EXTENSION_JS: &str =
        include_str!("../../../cognia-plugin-template-vscode-extension/extension/out/extension.js");
    pub const STYLES: &str =
        include_str!("../../../cognia-plugin-template-vscode-extension/styles.css");
    pub const README: &str =
        include_str!("../../../cognia-plugin-template-vscode-extension/README.md");
    pub const GITIGNORE: &str =
        include_str!("../../../cognia-plugin-template-vscode-extension/.gitignore");
}

/// The author-facing TypeScript declarations vendored into every scaffolded
/// TS project, generated by `scripts/plugin/generate-author-types.mjs`.
///
/// Rebuild with `pnpm author-types:bundle`; `-- --check` fails on drift.
pub mod author_types {
    pub const BUNDLE_JSON: &str = include_str!("../../assets/author-types.json");
}

/// A file to write during template stamping, with its destination
/// (relative to the target dir) and its content.
pub struct TemplateFile {
    pub rel_path: PathBuf,
    pub content: String,
}

#[derive(serde::Deserialize)]
struct AuthorTypesBundle {
    files: std::collections::BTreeMap<String, String>,
}

/// Expand the vendored `@cognia/*` declarations into scaffold files.
///
/// No `@cognia/*` package is published to any registry, so a scaffolded project
/// cannot resolve the SDK or the UI kit through `node_modules`. It resolves them
/// through `tsconfig.json` `paths` pointing at these files instead. Runtime is
/// unaffected — both stay `--external` and the host supplies its own instances.
pub fn author_type_files() -> Vec<TemplateFile> {
    let bundle: AuthorTypesBundle = serde_json::from_str(author_types::BUNDLE_JSON).expect(
        "author-types.json is generated and checked in — a parse failure means it is corrupt",
    );
    bundle
        .files
        .into_iter()
        .map(|(rel, content)| TemplateFile {
            rel_path: rel.split('/').collect::<PathBuf>(),
            content,
        })
        .collect()
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
        TemplateKind::Ts => {
            let mut files = vec![
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
                    rel_path: PathBuf::from("src").join("panel.tsx"),
                    content: substitute_ts_name(ts::SRC_PANEL_TSX, plugin_name),
                },
                TemplateFile {
                    rel_path: PathBuf::from("src").join("panel.test.tsx"),
                    content: substitute_ts_name(ts::SRC_PANEL_TEST_TSX, plugin_name),
                },
                TemplateFile {
                    rel_path: PathBuf::from("src").join("panel.css"),
                    content: substitute_ts_name(ts::SRC_PANEL_CSS, plugin_name),
                },
                TemplateFile {
                    rel_path: PathBuf::from("src").join("__stubs__").join("plugin-sdk.ts"),
                    content: ts::SRC_STUB_SDK.into(),
                },
                TemplateFile {
                    rel_path: PathBuf::from("src").join("__stubs__").join("plugin-ui.tsx"),
                    content: ts::SRC_STUB_UI.into(),
                },
                TemplateFile {
                    rel_path: PathBuf::from(".gitignore"),
                    content: ts::GITIGNORE.into(),
                },
                TemplateFile {
                    rel_path: PathBuf::from("README.md"),
                    content: ts::README.into(),
                },
            ];
            files.extend(author_type_files());
            files
        }
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
    name.split(['-', '_'])
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

    fn find_file<'a>(files: &'a [TemplateFile], path: &str) -> &'a TemplateFile {
        files
            .iter()
            .find(|file| file.rel_path.as_path() == Path::new(path))
            .unwrap_or_else(|| panic!("missing template file: {path}"))
    }

    fn has_file(files: &[TemplateFile], path: &str) -> bool {
        files
            .iter()
            .any(|file| file.rel_path.as_path() == Path::new(path))
    }

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
            let gi = find_file(&files, ".gitignore");
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
        let cargo = find_file(&files, "Cargo.toml");
        assert!(cargo.content.contains(r#"name = "my-plugin""#));
        let pj = find_file(&files, "plugin.json");
        assert!(pj.content.contains(r#""id": "my-plugin""#));
    }

    #[test]
    fn wasm_main_matches_cargo_component_normalized_artifact_name() {
        // cargo-component emits `<crate>.wasm` with `-` normalized to `_`,
        // so `wasmMain` must be the underscored artifact name — not the
        // hyphenated package name. Before the fix a scaffold named
        // `hello-wasm` shipped `wasmMain: "cognia_plugin_template.wasm"`.
        let files = files_for(TemplateKind::Wasm, "hello-wasm");
        let pj = find_file(&files, "plugin.json");
        assert!(
            pj.content.contains(r#""wasmMain": "hello_wasm.wasm""#),
            "wasmMain should be the underscored artifact name, got:\n{}",
            pj.content
        );
        assert!(pj.content.contains(r#""id": "hello-wasm""#));
    }

    /// Working Rule 7 across every kind, not just wasm: a declared capability
    /// whose contribution field is empty is a scaffold that ships a dormant
    /// tag, and `cognia plugin lint` warns on exactly that. Reading the pairing
    /// from `CAPABILITY_FIELDS` rather than a local list means a new capability
    /// cannot quietly escape the invariant.
    #[test]
    fn every_template_backs_its_declared_capabilities_with_contributions() {
        let mut checked = 0usize;
        for kind in TemplateKind::ALL {
            let files = files_for(kind, "probe");
            let manifest: serde_json::Value =
                serde_json::from_str(&find_file(&files, "plugin.json").content).unwrap();
            let declared: Vec<&str> = manifest["capabilities"]
                .as_array()
                .expect("capabilities is an array")
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            for capability in declared {
                let Some((_, fields)) = crate::engine::contract::CAPABILITY_FIELDS
                    .iter()
                    .find(|(id, _)| *id == capability)
                else {
                    // `configuration` and `python` gate on a manifest field the
                    // capability table does not pair them with. Nothing to check.
                    continue;
                };
                let populated = fields.iter().any(|field| match manifest.get(*field) {
                    Some(serde_json::Value::Array(entries)) => !entries.is_empty(),
                    Some(serde_json::Value::Object(block)) if *field == "workflows" => {
                        ["nodes", "triggers"].iter().any(|key| {
                            block
                                .get(*key)
                                .and_then(serde_json::Value::as_array)
                                .is_some_and(|entries| !entries.is_empty())
                        })
                    }
                    _ => false,
                });
                assert!(
                    populated,
                    "{kind:?} declares capability \"{capability}\" but every one of its \
                     contribution fields {fields:?} is empty"
                );
                checked += 1;
            }
        }
        // A walk that saw nothing passes every assertion inside it, so pin that
        // the walk actually had something to check.
        assert!(
            checked >= 8,
            "expected the templates to declare capabilities worth checking, saw {checked}"
        );
    }

    /// The reverse direction: a populated contribution field with no capability
    /// tag is the other half of the same lint rule.
    #[test]
    fn every_template_declares_a_capability_for_each_contribution_it_ships() {
        for kind in TemplateKind::ALL {
            let files = files_for(kind, "probe");
            let manifest: serde_json::Value =
                serde_json::from_str(&find_file(&files, "plugin.json").content).unwrap();
            let declared: Vec<&str> = manifest["capabilities"]
                .as_array()
                .expect("capabilities is an array")
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            for (capability, fields) in crate::engine::contract::CAPABILITY_FIELDS {
                if declared.contains(capability) {
                    continue;
                }
                for field in fields.iter() {
                    let populated = match manifest.get(*field) {
                        Some(serde_json::Value::Array(entries)) => !entries.is_empty(),
                        Some(serde_json::Value::Object(block)) if *field == "workflows" => {
                            ["nodes", "triggers"].iter().any(|key| {
                                block
                                    .get(*key)
                                    .and_then(serde_json::Value::as_array)
                                    .is_some_and(|entries| !entries.is_empty())
                            })
                        }
                        _ => false,
                    };
                    let covered = crate::engine::contract::CAPABILITY_FIELDS
                        .iter()
                        .filter(|(_, candidates)| candidates.contains(field))
                        .any(|(id, _)| declared.contains(id));
                    assert!(
                        !populated || covered,
                        "{kind:?} ships \"{field}\" entries but declares none of the \
                         capabilities that gate it"
                    );
                }
            }
        }
    }

    /// Every permission a template asks for has to be one the host knows, and
    /// has to say why. A scaffold that ships an unexplained grant teaches the
    /// habit of shipping unexplained grants.
    #[test]
    fn every_template_permission_is_known_and_justified() {
        for kind in TemplateKind::ALL {
            let files = files_for(kind, "probe");
            let manifest: serde_json::Value =
                serde_json::from_str(&find_file(&files, "plugin.json").content).unwrap();
            let Some(permissions) = manifest["permissions"].as_array() else {
                continue;
            };
            for permission in permissions.iter().filter_map(serde_json::Value::as_str) {
                assert!(
                    crate::engine::contract::VALID_PERMISSIONS.contains(&permission),
                    "{kind:?} asks for unknown permission \"{permission}\""
                );
                assert!(
                    manifest["permissionJustifications"]
                        .get(permission)
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|reason| !reason.trim().is_empty()),
                    "{kind:?} asks for \"{permission}\" with no permissionJustifications entry"
                );
            }
        }
    }

    #[test]
    fn ts_template_wires_the_surfaces_its_manifest_declares() {
        let source = ts::SRC_INDEX_TS;
        for call in [
            "ctx.agent.registerTool",
            "ctx.extensions.registerExtension",
            "ctx.workflow.registerNode",
            "ctx.workflow.registerTrigger",
            "ctx.settings.get",
            "ctx.settings.onChange",
            "ctx.storage.get",
            "ctx.lifecycle.onDispose",
            "onConfigChange",
        ] {
            assert!(
                source.contains(call),
                "TS template should demonstrate {call}"
            );
        }
        // The quick action dispatches the slash command rather than carrying a
        // second handler, so the two ids must agree.
        let manifest: serde_json::Value = serde_json::from_str(ts::PLUGIN_JSON).unwrap();
        assert_eq!(
            manifest["quickActions"][0]["slash"].as_str(),
            manifest["commands"][0]["id"].as_str(),
            "the quick action must dispatch a command the manifest declares"
        );
    }

    #[test]
    fn hybrid_template_crosses_the_runtime_seam() {
        // The point of the hybrid kind is that one half can call the other. A
        // template whose halves never talk teaches nothing the two single-runtime
        // templates do not already teach.
        assert!(
            hybrid::FRONTEND_INDEX_JS.contains("ctx.python.call(\"word_count\""),
            "hybrid frontend should call into its own Python backend"
        );
        assert!(
            hybrid::BACKEND_MAIN_PY.contains("def word_count("),
            "hybrid backend should expose the module-level callable the frontend calls"
        );
    }

    #[test]
    fn python_template_registers_a_hook_for_its_declared_panel() {
        // A declarative A2UI panel is built by `activateTool` and answered by
        // the `onA2UIAction` hook. Declaring the panel without the hook ships a
        // panel whose buttons do nothing.
        let manifest: serde_json::Value = serde_json::from_str(python::PLUGIN_JSON).unwrap();
        let activate_tool = manifest["contextPanels"][0]["activateTool"]
            .as_str()
            .expect("the declared panel names an activateTool");
        assert!(
            manifest["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"].as_str() == Some(activate_tool)),
            "the panel's activateTool must be a declared tool"
        );
        assert!(python::MAIN_PY.contains(&format!("def {activate_tool}(")));
        assert!(python::MAIN_PY.contains("@hook(\"onA2UIAction\")"));
    }

    #[test]
    fn wasm_template_ships_a_live_capability() {
        // Working Rule 7: no dormant scaffolds. The wasm template's
        // `tool_execute` export must be backed by a declared `tools` capability
        // and a non-empty `tools[]` (matching ts/python/hybrid) — otherwise it
        // ships `capabilities: []` while its code implements a tool, which is a
        // latent bug the linter would rightly flag as dead weight.
        let files = files_for(TemplateKind::Wasm, "probe");
        let pj = find_file(&files, "plugin.json");
        let m: serde_json::Value = serde_json::from_str(&pj.content).unwrap();
        let caps = m["capabilities"]
            .as_array()
            .expect("capabilities is an array");
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
        let pj = find_file(&files, "plugin.json");
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        let pkg = find_file(&files, "package.json");
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
        let pj = find_file(&files, "plugin.json");
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        assert!(pj.content.contains(r#""type": "python""#));
        assert!(pj.content.contains(r#""pythonMain": "main.py""#));
        let main = find_file(&files, "main.py");
        assert!(main.content.contains("from cognia import "));
        assert!(main.content.contains(", tool"));
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
            assert!(has_file(&files, expected), "missing: {expected}");
        }
        let pj = find_file(&files, "plugin.json");
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
            assert!(has_file(&files, expected), "missing: {expected}");
        }
        let pj = find_file(&files, "plugin.json");
        assert!(pj.content.contains(r#""id": "my-plugin""#));
        assert!(pj.content.contains(r#""type": "vscode-extension""#));
        assert!(pj
            .content
            .contains(r#""vscodeMain": "extension/out/extension.js""#));
        assert!(pj.content.contains(r#""styles": "styles.css""#));
        assert!(pj.content.contains(r#""bundle_include": ["package.json"]"#));
    }

    #[test]
    fn python_templates_report_progress_as_a_percentage() {
        // `pct` is 0-100. The host renders it verbatim with a `%` suffix
        // (`lib/plugin/devtools/runtime-log-stream.ts`), so a template that
        // reports 0.5 / 1.0 shows an author "1%" for a finished call and
        // teaches a scale nothing in the runtime uses. The behavioural twin of
        // this check drives the asset itself:
        // `plugin-sdk/python/tests/test_template_plugin.py`.
        for (label, source) in [
            ("python", python::MAIN_PY),
            ("hybrid", hybrid::BACKEND_MAIN_PY),
        ] {
            assert!(
                !source.contains("progress(0."),
                "{label} template reports a fractional progress value"
            );
            assert!(
                !source.contains("progress(1.0"),
                "{label} template reports 1.0 for a finished call"
            );
        }
        assert!(python::MAIN_PY.contains(r#"progress(50, "writing note")"#));
        assert!(python::MAIN_PY.contains(r#"progress(100, "done")"#));
    }

    /// The host merges the module's manifest OVER `plugin.json`
    /// (`lib/plugin/core/browser-builtin-registry.ts:builtinManifest`), so the
    /// code's list is the one that survives. A tag the file declares and the
    /// code drops is a contribution the running plugin never claims, and the
    /// dormancy tests above only read the file, so they cannot see it.
    #[test]
    fn ts_template_declares_the_same_capabilities_in_both_halves() {
        let manifest: serde_json::Value = serde_json::from_str(ts::PLUGIN_JSON).unwrap();
        for capability in manifest["capabilities"]
            .as_array()
            .expect("capabilities is an array")
            .iter()
            .filter_map(serde_json::Value::as_str)
        {
            assert!(
                ts::SRC_INDEX_TS.contains(&format!("\"{capability}\"")),
                "plugin.json declares \"{capability}\" but src/index.ts's manifest omits it"
            );
        }
    }

    #[test]
    fn ts_template_uses_only_the_public_sdk() {
        let source = ts::SRC_INDEX_TS;
        assert!(source.contains("@cognia/plugin-sdk"));
        assert!(source.contains("ctx.agent.registerTool"));
        assert!(source.contains("onCommand"));
        assert!(!ts::TSCONFIG_JSON.contains("skipLibCheck"));
        assert!(ts::TSCONFIG_JSON.contains(r#""module": "NodeNext""#));
        assert!(ts::TSCONFIG_JSON.contains(r#""moduleResolution": "NodeNext""#));
        assert!(ts::TSCONFIG_JSON.contains(r#""isolatedModules": true"#));
        for forbidden in ["@/lib", "@/types", "plugin-sdk/host"] {
            assert!(
                !source.contains(forbidden),
                "TypeScript template must not import host-only module {forbidden}"
            );
        }
        // No `@cognia/*` package is published, so declaring one as a dependency
        // makes `pnpm install` fail outright. They are vendored as declarations
        // and resolved through tsconfig `paths` instead.
        for unresolvable in [r#""@cognia/plugin-sdk": "^"#, r#""@cognia/plugin-ui": "^"#] {
            assert!(
                !ts::PACKAGE_JSON.contains(unresolvable),
                "template must not depend on the unpublished {unresolvable}"
            );
        }
        // The vendored SDK declaration surface re-exports ACP protocol types,
        // so standalone author projects must be able to resolve that published
        // peer without relying on this repository's node_modules.
        assert!(ts::PACKAGE_JSON.contains(r#""@agentclientprotocol/sdk": "^1.4.0""#));
        // They stay external at build time — the host hands out its instances.
        assert!(ts::PACKAGE_JSON.contains("--external:@cognia/plugin-sdk"));
        assert!(ts::PACKAGE_JSON.contains("--external:@cognia/plugin-ui"));
        // `react-dom` is deliberately NOT a shared module, so marking it
        // external would defer the failure from build time to `require()` time.
        assert!(!ts::PACKAGE_JSON.contains("--external:react-dom"));
        // The declarations the SDK's own type surface transitively needs.
        for mapped in [
            r#""@cognia/plugin-sdk": ["./types/cognia-plugin-sdk.d.ts"]"#,
            r#""@cognia/plugin-ui": ["./types/cognia-plugin-ui.d.ts"]"#,
            r#""@cognia/provider-types/*""#,
            r#""@cognia/provider-core/*""#,
        ] {
            assert!(
                ts::TSCONFIG_JSON.contains(mapped),
                "tsconfig must map {mapped}"
            );
        }
    }

    #[test]
    fn ts_scaffold_vendors_the_author_declarations() {
        let files = files_for(TemplateKind::Ts, "my-plugin");
        for expected in [
            "types/cognia-plugin-sdk.d.ts",
            "types/cognia-plugin-ui.d.ts",
            "types/provider-types/index.d.ts",
            "types/provider-core/core/client.d.ts",
        ] {
            let rel: PathBuf = expected.split('/').collect();
            assert!(
                files.iter().any(|f| f.rel_path == rel),
                "scaffold must vendor {expected}"
            );
        }
        // A vendored declaration that still imports an unpublished package
        // would not resolve in an author's project.
        let sdk = files
            .iter()
            .find(|f| f.rel_path == PathBuf::from("types").join("cognia-plugin-sdk.d.ts"))
            .expect("sdk declaration present");
        for orphan in ["@cognia/plugin-ui", "@cognia/provider-routing"] {
            assert!(
                !sdk.content.contains(orphan),
                "vendored SDK declaration must not reference unmapped {orphan}"
            );
        }
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
