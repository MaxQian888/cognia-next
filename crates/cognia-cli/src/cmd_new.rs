//! `cognia plugin new <name> [--kind wasm|ts]` — stamp the bundled template
//! into a new directory.
//!
//! Two kinds ship today:
//!   * `wasm` (default): Rust + cargo-component starter for a WASM
//!     Component Model plugin.
//!   * `ts`: TypeScript frontend plugin with esbuild + jest already wired.

use anyhow::{anyhow, bail, Context, Result};
use std::path::PathBuf;

use crate::signing::Keypair;
use crate::template::{files_for, next_steps, TemplateKind};
use crate::ui::{style, RuntimeUi};

const ID_PATTERN_HINT: &str = "lowercase alphanumeric plus -_.";

/// Collected, fully-resolved set of wizard answers. Either filled in
/// directly from CLI flags, prompted via dialoguer, or defaulted.
struct WizardAnswers {
    name: String,
    dir: Option<PathBuf>,
    kind: TemplateKind,
    description: String,
    author_name: String,
    author_email: Option<String>,
    with_keygen: bool,
}

/// Public entry point invoked by `dispatch_plugin`.
///
/// Behavior:
///   * Every flag explicitly passed wins — the wizard never asks again
///     for a field the caller already provided.
///   * Missing fields on a TTY trigger an interactive prompt (5–6 steps).
///   * Missing fields on a non-TTY: `name` is required (bail with hint),
///     the rest fall back to sensible defaults (kind=wasm, description=
///     empty placeholder, author=current user, no keygen).
#[allow(clippy::too_many_arguments)]
pub fn run(
    name: Option<String>,
    dir: Option<PathBuf>,
    kind: Option<String>,
    author: Option<String>,
    author_email: Option<String>,
    description: Option<String>,
    with_keygen: Option<bool>,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let answers = collect_answers(
        name,
        dir,
        kind,
        author,
        author_email,
        description,
        with_keygen,
        ui,
    )?;

    // Run the bare-metal stamp first so we have a manifest file on disk
    // to mutate when the wizard requested an embedded public key.
    let target_dir = answers
        .dir
        .clone()
        .unwrap_or_else(|| PathBuf::from(&answers.name));
    stamp(answers.name.clone(), Some(target_dir.clone()), answers.kind)?;

    // Patch plugin.json with the collected metadata. Template writes a
    // minimal stub; the wizard supplies real values via in-place rewrite
    // so dispatch_plugin doesn't need to thread them all the way down.
    patch_manifest(&target_dir, &answers)?;

    // Optional: generate a keypair and embed the public key.
    if answers.with_keygen {
        let key_dir = target_dir.join(".cognia");
        std::fs::create_dir_all(&key_dir)
            .with_context(|| format!("mkdir {}", key_dir.display()))?;
        let kp = Keypair::generate();
        std::fs::write(key_dir.join("plugin.private.b64"), kp.private_base64())
            .context("write plugin.private.b64")?;
        std::fs::write(key_dir.join("plugin.public.b64"), kp.public_base64())
            .context("write plugin.public.b64")?;
        embed_public_key(&target_dir, &kp.public_base64())?;
        println!();
        println!(
            "{}embedded author.publicKey ({})",
            style::success_prefix(),
            style::dim(&kp.public_base64())
        );
        println!(
            "  {}private key stored at {}",
            style::dim("·"),
            style::bold(
                key_dir
                    .join("plugin.private.b64")
                    .display()
                    .to_string()
            )
        );
    }

    Ok(())
}

/// Resolve every field in `WizardAnswers`. Flags > prompt > default.
#[allow(clippy::too_many_arguments)]
fn collect_answers(
    cli_name: Option<String>,
    cli_dir: Option<PathBuf>,
    cli_kind: Option<String>,
    cli_author: Option<String>,
    cli_author_email: Option<String>,
    cli_description: Option<String>,
    cli_with_keygen: Option<bool>,
    ui: &mut RuntimeUi,
) -> Result<WizardAnswers> {
    let is_tty = ui.is_tty;

    // ── name ────────────────────────────────────────────────────────────
    let name = match cli_name {
        Some(n) => n,
        None if !is_tty => bail!(
            "plugin name is required on a non-interactive shell; pass `<name>` explicitly (or run from a TTY for the wizard)"
        ),
        None => ui
            .prompter()
            .input("Plugin name", default_name_from_cwd().as_deref(), "<name>")
            .map_err(|e| anyhow!("{e}"))?,
    };
    validate_name(&name)?;

    // ── kind ────────────────────────────────────────────────────────────
    let kind = match cli_kind {
        Some(s) => TemplateKind::parse(&s)?,
        None if !is_tty => TemplateKind::Wasm,
        None => {
            let items = ["wasm  (Rust + cargo-component)", "ts    (TypeScript frontend)"];
            let idx = ui
                .prompter()
                .select("Template kind", &items, 0, "--kind wasm|ts")
                .map_err(|e| anyhow!("{e}"))?;
            match idx {
                0 => TemplateKind::Wasm,
                _ => TemplateKind::Ts,
            }
        }
    };

    // ── description ─────────────────────────────────────────────────────
    let description = match cli_description {
        Some(d) => d,
        None if !is_tty => format!("A cognia {} plugin", kind_label(kind)),
        None => ui
            .prompter()
            .input(
                "Short description",
                Some(&format!("A cognia {} plugin", kind_label(kind))),
                "--description",
            )
            .map_err(|e| anyhow!("{e}"))?,
    };

    // ── author name ─────────────────────────────────────────────────────
    let author_default = git_user_name();
    let author_name = match cli_author {
        Some(a) => a,
        None if !is_tty => author_default.unwrap_or_else(|| "Anonymous".to_string()),
        None => ui
            .prompter()
            .input(
                "Author name",
                author_default.as_deref(),
                "--author \"Your Name\"",
            )
            .map_err(|e| anyhow!("{e}"))?,
    };

    // ── author email (optional) ─────────────────────────────────────────
    let author_email = match cli_author_email {
        Some(e) => Some(e),
        None if !is_tty => None,
        None => ui
            .prompter()
            .input_optional("Author email (optional, blank to skip)", "--author-email")
            .map_err(|e| anyhow!("{e}"))?,
    };

    // ── with_keygen ─────────────────────────────────────────────────────
    let with_keygen = match cli_with_keygen {
        Some(b) => b,
        None if !is_tty => false,
        None => ui
            .prompter()
            .confirm(
                "Generate a signing keypair now and embed the public key?",
                true,
                "--with-keygen true|false",
            )
            .map_err(|e| anyhow!("{e}"))?,
    };

    Ok(WizardAnswers {
        name,
        dir: cli_dir,
        kind,
        description,
        author_name,
        author_email,
        with_keygen,
    })
}

fn kind_label(kind: TemplateKind) -> &'static str {
    match kind {
        TemplateKind::Wasm => "WASM",
        TemplateKind::Ts => "frontend TypeScript",
    }
}

/// Best-effort default name from the current working directory's basename.
/// Falls back to `None` (the prompter then asks with no default).
fn default_name_from_cwd() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let base = cwd.file_name()?.to_string_lossy().into_owned();
    if validate_name(&base).is_ok() {
        Some(base)
    } else {
        None
    }
}

/// Best-effort `git config user.name`. Errors and missing git swallow to
/// `None` so the prompt just falls back to no default.
fn git_user_name() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["config", "--get", "user.name"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Read the stamped plugin.json, overlay the wizard answers, and write
/// it back. Keeps existing fields the template wrote untouched.
fn patch_manifest(target_dir: &std::path::Path, answers: &WizardAnswers) -> Result<()> {
    let manifest_path = target_dir.join("plugin.json");
    let bytes = std::fs::read(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "description".into(),
            serde_json::Value::String(answers.description.clone()),
        );
        let mut author = serde_json::Map::new();
        author.insert(
            "name".into(),
            serde_json::Value::String(answers.author_name.clone()),
        );
        if let Some(email) = &answers.author_email {
            author.insert("email".into(), serde_json::Value::String(email.clone()));
        }
        obj.insert("author".into(), serde_json::Value::Object(author));
    }
    let pretty = serde_json::to_string_pretty(&value)? + "\n";
    std::fs::write(&manifest_path, pretty)
        .with_context(|| format!("write {}", manifest_path.display()))?;
    Ok(())
}

/// Re-read plugin.json and set `author.publicKey`. Used by `--with-keygen`.
fn embed_public_key(target_dir: &std::path::Path, pub_b64: &str) -> Result<()> {
    let manifest_path = target_dir.join("plugin.json");
    let bytes = std::fs::read(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    if let Some(obj) = value.as_object_mut() {
        let author = obj
            .entry("author")
            .or_insert_with(|| serde_json::Value::Object(Default::default()));
        if let Some(author_obj) = author.as_object_mut() {
            author_obj.insert(
                "publicKey".into(),
                serde_json::Value::String(pub_b64.to_string()),
            );
        }
    }
    let pretty = serde_json::to_string_pretty(&value)? + "\n";
    std::fs::write(&manifest_path, pretty)
        .with_context(|| format!("write {}", manifest_path.display()))?;
    Ok(())
}

/// Bare-metal stamping: validate name, create target dir, write template
/// files, print next-steps. Phase 1 keeps this signature stable so existing
/// tests (which exercise it directly) need no churn.
pub(crate) fn stamp(name: String, dir: Option<PathBuf>, kind: TemplateKind) -> Result<()> {
    validate_name(&name)?;
    let target_dir = dir.unwrap_or_else(|| PathBuf::from(&name));
    if target_dir.exists() {
        let entries = std::fs::read_dir(&target_dir)
            .ok()
            .map(|d| d.count())
            .unwrap_or(0);
        if entries > 0 {
            bail!("{} already exists and is not empty", target_dir.display());
        }
    }
    std::fs::create_dir_all(&target_dir)
        .with_context(|| format!("create target dir {}", target_dir.display()))?;

    for file in files_for(kind, &name) {
        let dest = target_dir.join(&file.rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))?;
        }
        std::fs::write(&dest, file.content.as_bytes())
            .with_context(|| format!("write {}", dest.display()))?;
    }

    println!(
        "Created {} plugin at {}",
        match kind {
            TemplateKind::Wasm => "WASM",
            TemplateKind::Ts => "frontend TypeScript",
        },
        target_dir.display()
    );
    println!();
    println!("Next steps:");
    for step in next_steps(kind, &target_dir) {
        println!("  {step}");
    }
    Ok(())
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("plugin name is empty");
    }
    if name.len() > 64 {
        bail!("plugin name must be ≤ 64 characters");
    }
    let valid = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c.is_ascii_digit())
            .unwrap_or(false);
    if !valid {
        bail!("plugin name must be {} (got `{}`)", ID_PATTERN_HINT, name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validate_name_accepts_clean_ids() {
        assert!(validate_name("my-plugin").is_ok());
        assert!(validate_name("foo.bar_1").is_ok());
        assert!(validate_name("0plugin").is_ok());
    }

    #[test]
    fn validate_name_rejects_bad_ids() {
        assert!(validate_name("").is_err());
        assert!(validate_name("has space").is_err());
        assert!(validate_name("!banged").is_err());
        assert!(validate_name(&"a".repeat(100)).is_err());
    }

    #[test]
    fn new_stamps_wasm_template_by_default() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("hello-wasm");
        stamp("hello-wasm".into(), Some(target.clone()), TemplateKind::Wasm).unwrap();
        for relpath in [
            "Cargo.toml",
            "src/lib.rs",
            "plugin.json",
            "wit/world.wit",
            "README.md",
        ] {
            assert!(target.join(relpath).exists(), "missing: {relpath}");
        }
        let cargo = std::fs::read_to_string(target.join("Cargo.toml")).unwrap();
        assert!(cargo.contains(r#"name = "hello-wasm""#));
        let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
        assert!(manifest.contains(r#""id": "hello-wasm""#));
    }

    #[test]
    fn new_stamps_ts_template_when_kind_ts() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("hello-ts");
        stamp("hello-ts".into(), Some(target.clone()), TemplateKind::Ts).unwrap();
        for relpath in [
            "package.json",
            "tsconfig.json",
            "jest.config.cjs",
            "plugin.json",
            "src/index.ts",
            "src/index.test.ts",
            "src/__shims__/types/plugin.ts",
            "src/__shims__/lib/chat/slash-command-registry.ts",
            "README.md",
        ] {
            assert!(target.join(relpath).exists(), "missing: {relpath}");
        }
        let pkg = std::fs::read_to_string(target.join("package.json")).unwrap();
        assert!(pkg.contains(r#""name": "hello-ts""#));
        let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
        assert!(manifest.contains(r#""id": "hello-ts""#));
        assert!(manifest.contains(r#""type": "frontend""#));
    }

    #[test]
    fn new_rejects_non_empty_target() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("occupied");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("seed"), "x").unwrap();
        let err = stamp("occupied".into(), Some(target), TemplateKind::Wasm).unwrap_err();
        assert!(err.to_string().contains("not empty"));
    }

    #[test]
    fn new_creates_target_dir_when_missing() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("nested").join("dir").join("plugin");
        stamp("plugin".into(), Some(target.clone()), TemplateKind::Ts).unwrap();
        assert!(target.exists());
        assert!(target.join("package.json").exists());
    }

    #[test]
    fn run_without_name_bails_on_non_tty() {
        use crate::ui::runtime::UiFlags;
        let mut ui = RuntimeUi::new(UiFlags::default());
        let err = run(None, None, None, None, None, None, None, &mut ui).unwrap_err();
        assert!(
            err.to_string().contains("plugin name is required"),
            "got: {err}"
        );
    }

    #[test]
    fn run_with_explicit_name_stamps_and_patches_manifest() {
        use crate::ui::runtime::UiFlags;
        let parent = tempdir().unwrap();
        let target = parent.path().join("named-plugin");
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(
            Some("named-plugin".into()),
            Some(target.clone()),
            Some("wasm".into()),
            Some("Max Qian".into()),
            Some("max@example.com".into()),
            Some("Test plugin".into()),
            Some(false),
            &mut ui,
        )
        .unwrap();
        let manifest_text = std::fs::read_to_string(target.join("plugin.json")).unwrap();
        let m: serde_json::Value = serde_json::from_str(&manifest_text).unwrap();
        assert_eq!(m["description"], serde_json::Value::String("Test plugin".into()));
        assert_eq!(m["author"]["name"], serde_json::Value::String("Max Qian".into()));
        assert_eq!(
            m["author"]["email"],
            serde_json::Value::String("max@example.com".into())
        );
        assert!(m["author"].get("publicKey").is_none(), "no keygen → no publicKey");
    }

    #[test]
    fn run_with_keygen_embeds_public_key() {
        use crate::ui::runtime::UiFlags;
        let parent = tempdir().unwrap();
        let target = parent.path().join("signed-plugin");
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(
            Some("signed-plugin".into()),
            Some(target.clone()),
            Some("ts".into()),
            Some("Author".into()),
            None,
            Some("desc".into()),
            Some(true), // with_keygen
            &mut ui,
        )
        .unwrap();
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(target.join("plugin.json")).unwrap())
                .unwrap();
        let pk = m["author"]["publicKey"]
            .as_str()
            .expect("publicKey set in plugin.json");
        // base64 32-byte = 44 chars with padding
        assert_eq!(pk.trim().len(), 44, "got: {pk:?}");
        assert!(target.join(".cognia/plugin.private.b64").exists());
        assert!(target.join(".cognia/plugin.public.b64").exists());
    }

    #[test]
    fn wizard_collects_all_fields_via_mock_prompter() {
        use crate::ui::prompter::{Answer, MockPrompter};
        use crate::ui::runtime::UiFlags;
        let parent = tempdir().unwrap();
        let target = parent.path().join("wizard-plugin");
        let answers = vec![
            Answer::Input("wizard-plugin".into()),       // name
            Answer::Select(1),                            // kind = ts
            Answer::Input("From wizard".into()),         // description
            Answer::Input("Max".into()),                 // author name
            Answer::InputOptional(Some("m@x.io".into())), // author email
            Answer::Confirm(false),                       // with_keygen
        ];
        // Force is_tty=true on the RuntimeUi by injecting a MockPrompter
        // and lying about TTY via a follow-up mutation — the wizard only
        // checks `ui.is_tty`, so we override it manually.
        let mut ui = RuntimeUi::new(UiFlags::default())
            .with_prompter(Box::new(MockPrompter::with_answers(answers)));
        ui.is_tty = true;
        run(
            None,
            Some(target.clone()),
            None,
            None,
            None,
            None,
            None,
            &mut ui,
        )
        .unwrap();
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(target.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(m["id"], serde_json::Value::String("wizard-plugin".into()));
        assert_eq!(m["type"], serde_json::Value::String("frontend".into()));
        assert_eq!(m["description"], serde_json::Value::String("From wizard".into()));
        assert_eq!(m["author"]["name"], serde_json::Value::String("Max".into()));
        assert_eq!(m["author"]["email"], serde_json::Value::String("m@x.io".into()));
    }

    #[test]
    fn wizard_bails_on_non_tty_when_name_missing() {
        use crate::ui::runtime::UiFlags;
        let mut ui = RuntimeUi::new(UiFlags::default());
        ui.is_tty = false;
        let err = run(None, None, None, None, None, None, None, &mut ui).unwrap_err();
        assert!(err.to_string().contains("non-interactive shell"), "got: {err}");
    }

    #[test]
    fn patch_manifest_omits_email_when_absent() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(
            dir.join("plugin.json"),
            r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":[],"main":"x"}"#,
        )
        .unwrap();
        let answers = WizardAnswers {
            name: "x".into(),
            dir: None,
            kind: TemplateKind::Ts,
            description: "d".into(),
            author_name: "A".into(),
            author_email: None,
            with_keygen: false,
        };
        patch_manifest(dir, &answers).unwrap();
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(m["author"]["name"], serde_json::Value::String("A".into()));
        assert!(m["author"].get("email").is_none());
    }
}
