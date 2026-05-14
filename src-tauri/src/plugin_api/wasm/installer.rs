//! Install WASM plugin bundles from various sources (HTTP, Git, local file).
//!
//! Every install path lands at the same destination: a directory under
//! `<install_dir>/<plugin_id>/` containing the manifest JSON, the `.wasm`
//! component, and any auxiliary assets shipped in the bundle. Signature
//! verification (Ed25519 detached) and manifest sanity-checks happen
//! before the bundle is unpacked.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use super::super::PluginRuntimeState;

/// What we return to the TS side after a successful install. Mirrors the
/// `plugin_install` command's response so the manager-side dispatch is
/// unchanged for new install paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmInstallResult {
    pub manifest: serde_json::Value,
    pub path: String,
    pub source: String,
    pub install_root_kind: String,
    pub signature_verified: bool,
    pub author_public_key: Option<String>,
    pub author_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PartialManifest {
    id: String,
    #[serde(default)]
    #[serde(rename = "type")]
    plugin_type: Option<String>,
    #[serde(rename = "wasmMain", default)]
    wasm_main: Option<String>,
    #[serde(default)]
    author: Option<PartialAuthor>,
    #[serde(default)]
    wasm: Option<PartialWasmBlock>,
}

#[derive(Debug, Deserialize)]
struct PartialAuthor {
    #[serde(default)]
    #[allow(dead_code)]
    name: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    email: Option<String>,
    #[serde(default, rename = "publicKey")]
    public_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PartialWasmBlock {
    #[serde(rename = "apiVersion")]
    api_version: String,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn verify_detached(
    bundle: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(), String> {
    let pk = b64()
        .decode(public_key_base64.as_bytes())
        .map_err(|e| format!("public key base64 decode: {e}"))?;
    let pk: [u8; 32] = pk
        .as_slice()
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    let verifying = VerifyingKey::from_bytes(&pk).map_err(|e| format!("invalid public key: {e}"))?;
    let sig = b64()
        .decode(signature_base64.as_bytes())
        .map_err(|e| format!("signature base64 decode: {e}"))?;
    let sig: [u8; SIGNATURE_LENGTH] = sig
        .as_slice()
        .try_into()
        .map_err(|_| format!("signature must be {SIGNATURE_LENGTH} bytes"))?;
    let signature = Signature::from_bytes(&sig);
    verifying
        .verify_strict(bundle, &signature)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Extract a `.zip` plugin bundle into `target_dir`. Skips path traversal
/// attempts (zip entries with `..` segments). Returns the path of the
/// extracted `plugin.json` if present.
fn extract_zip_bundle(bytes: &[u8], target_dir: &Path) -> Result<PathBuf, String> {
    let reader = Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("open zip bundle: {e}"))?;
    let mut manifest_path: Option<PathBuf> = None;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let entry_path = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue, // Skip absolute or `..` paths.
        };
        let target = target_dir.join(&entry_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {target:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut out =
            std::fs::File::create(&target).map_err(|e| format!("write {target:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy {target:?}: {e}"))?;
        if entry_path.file_name().is_some_and(|n| n == "plugin.json") {
            manifest_path = Some(target.clone());
        }
    }
    manifest_path.ok_or_else(|| "bundle is missing plugin.json".to_string())
}

fn read_manifest(path: &Path) -> Result<(serde_json::Value, PartialManifest), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read manifest {path:?}: {e}"))?;
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    let parsed: PartialManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest fields: {e}"))?;
    Ok((raw, parsed))
}

fn assert_wasm_manifest(parsed: &PartialManifest) -> Result<(), String> {
    if parsed.plugin_type.as_deref() != Some("wasm") {
        return Err("bundle manifest is not type: \"wasm\"".into());
    }
    if parsed.wasm_main.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("bundle manifest is missing wasmMain".into());
    }
    if parsed.wasm.as_ref().map(|w| w.api_version.trim()).unwrap_or("").is_empty() {
        return Err("bundle manifest is missing wasm.apiVersion".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_wasm_install_from_url(
    state: State<'_, PluginRuntimeState>,
    bundle_url: String,
    signature_url: Option<String>,
    expected_public_key_base64: Option<String>,
) -> Result<WasmInstallResult, String> {
    // Step 1 — fetch the bundle.
    let client = reqwest::Client::builder()
        .user_agent("cognia-plugin-installer/0.1")
        .build()
        .map_err(|e| format!("http client init: {e}"))?;
    let bundle = client
        .get(&bundle_url)
        .send()
        .await
        .map_err(|e| format!("download bundle: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download bundle (HTTP error): {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read bundle body: {e}"))?;

    // Step 2 — verify signature if requested.
    let mut signature_verified = false;
    if let (Some(sig_url), Some(pk_b64)) = (signature_url.as_ref(), expected_public_key_base64.as_ref())
    {
        let sig_body = client
            .get(sig_url)
            .send()
            .await
            .map_err(|e| format!("download signature: {e}"))?
            .error_for_status()
            .map_err(|e| format!("download signature (HTTP error): {e}"))?
            .text()
            .await
            .map_err(|e| format!("read signature body: {e}"))?;
        verify_detached(&bundle, sig_body.trim(), pk_b64)?;
        signature_verified = true;
    } else if expected_public_key_base64.is_some() {
        return Err("expected_public_key_base64 provided without signature_url".into());
    }

    // Step 3 — extract to a temp dir, parse manifest, validate.
    let staging = tempfile::tempdir().map_err(|e| format!("create temp dir: {e}"))?;
    let manifest_path = extract_zip_bundle(&bundle, staging.path())?;
    let (manifest_value, parsed) = read_manifest(&manifest_path)?;
    assert_wasm_manifest(&parsed)?;

    // Step 4 — move to the canonical plugins dir.
    let plugin_dir = state.plugin_dir(&parsed.id);
    if plugin_dir.exists() {
        std::fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("clear {plugin_dir:?}: {e}"))?;
    }
    std::fs::create_dir_all(&plugin_dir).map_err(|e| format!("mkdir {plugin_dir:?}: {e}"))?;
    copy_dir_recursive(staging.path(), &plugin_dir)?;

    let (author_pk, author_fp) = match parsed.author.as_ref().and_then(|a| a.public_key.clone()) {
        Some(pk) => {
            let decoded = b64().decode(pk.as_bytes()).ok();
            let fp = decoded.as_ref().map(|b| sha256_hex(b));
            (Some(pk), fp)
        }
        None => (None, None),
    };

    Ok(WasmInstallResult {
        manifest: manifest_value,
        path: plugin_dir.to_string_lossy().into_owned(),
        source: "marketplace".into(),
        install_root_kind: "installed".into(),
        signature_verified,
        author_public_key: author_pk,
        author_fingerprint: author_fp,
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let path = entry.path();
        let rel = path.strip_prefix(src).unwrap();
        let target = dst.join(rel);
        if path.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {target:?}: {e}"))?;
            copy_dir_recursive(&path, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
            }
            std::fs::copy(&path, &target).map_err(|e| format!("copy {path:?}: {e}"))?;
        }
    }
    Ok(())
}

/// Clone a Git repo (shallow) into a temp dir, build it with
/// `cargo-component` if the manifest has `[package.metadata.component]`,
/// then install the resulting `.wasm` + plugin.json. Toolchain absence
/// surfaces as a structured error the UI can render with install help.
#[tauri::command]
pub async fn plugin_wasm_install_from_git(
    state: State<'_, PluginRuntimeState>,
    repo_url: String,
    branch: Option<String>,
) -> Result<WasmInstallResult, String> {
    let staging = tempfile::tempdir().map_err(|e| format!("create temp dir: {e}"))?;
    let staging_path = staging.path().to_path_buf();

    // Step 1 — shallow clone.
    let mut git = Command::new("git");
    git.arg("clone").arg("--depth=1");
    if let Some(b) = branch.as_deref() {
        git.arg("--branch").arg(b);
    }
    git.arg(&repo_url).arg(&staging_path);
    let clone = git
        .output()
        .map_err(|e| format!("git clone (is git installed?): {e}"))?;
    if !clone.status.success() {
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&clone.stderr)
        ));
    }

    // Step 2 — detect `[package.metadata.component]` to decide whether to
    // build with cargo-component, or to look for a pre-built `.wasm`.
    let cargo_toml = staging_path.join("Cargo.toml");
    let needs_build = if cargo_toml.exists() {
        let body = std::fs::read_to_string(&cargo_toml).unwrap_or_default();
        body.contains("[package.metadata.component]")
    } else {
        false
    };

    if needs_build {
        let build = Command::new("cargo")
            .current_dir(&staging_path)
            .arg("component")
            .arg("build")
            .arg("--release")
            .output()
            .map_err(|e| {
                format!(
                    "cargo component build failed (is cargo-component installed? run `cargo install cargo-component`): {e}"
                )
            })?;
        if !build.status.success() {
            return Err(format!(
                "cargo component build failed:\n--- stdout ---\n{}\n--- stderr ---\n{}",
                String::from_utf8_lossy(&build.stdout),
                String::from_utf8_lossy(&build.stderr)
            ));
        }
    }

    // Step 3 — locate the manifest + .wasm in the staging tree.
    let manifest_path = find_plugin_manifest(&staging_path)
        .ok_or_else(|| "repository is missing plugin.json".to_string())?;
    let (manifest_value, parsed) = read_manifest(&manifest_path)?;
    assert_wasm_manifest(&parsed)?;

    // Compose the install dir and stamp only the necessary assets.
    let plugin_dir = state.plugin_dir(&parsed.id);
    if plugin_dir.exists() {
        std::fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("clear {plugin_dir:?}: {e}"))?;
    }
    std::fs::create_dir_all(&plugin_dir).map_err(|e| format!("mkdir {plugin_dir:?}: {e}"))?;
    std::fs::copy(&manifest_path, plugin_dir.join("plugin.json"))
        .map_err(|e| format!("copy plugin.json: {e}"))?;

    let wasm_main = parsed.wasm_main.clone().unwrap_or_default();
    let wasm_src = find_wasm_artifact(&staging_path, &wasm_main)
        .ok_or_else(|| format!("could not locate produced .wasm matching {wasm_main:?}"))?;
    let wasm_dst = plugin_dir.join(&wasm_main);
    if let Some(parent) = wasm_dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    std::fs::copy(&wasm_src, &wasm_dst).map_err(|e| format!("copy wasm artifact: {e}"))?;

    let (author_pk, author_fp) = match parsed.author.as_ref().and_then(|a| a.public_key.clone()) {
        Some(pk) => {
            let decoded = b64().decode(pk.as_bytes()).ok();
            let fp = decoded.as_ref().map(|b| sha256_hex(b));
            (Some(pk), fp)
        }
        None => (None, None),
    };

    Ok(WasmInstallResult {
        manifest: manifest_value,
        path: plugin_dir.to_string_lossy().into_owned(),
        source: "git".into(),
        install_root_kind: "installed".into(),
        signature_verified: false,
        author_public_key: author_pk,
        author_fingerprint: author_fp,
    })
}

fn find_plugin_manifest(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("plugin.json");
    if candidate.exists() {
        return Some(candidate);
    }
    // Allow `manifest/plugin.json` and one level of nesting for monorepo
    // layouts. We only look one level deep on purpose so a misplaced file
    // can't be silently picked.
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let nested = p.join("plugin.json");
            if nested.exists() {
                return Some(nested);
            }
        }
    }
    None
}

fn find_wasm_artifact(root: &Path, expected_basename: &str) -> Option<PathBuf> {
    let target_release = root.join("target").join("wasm32-wasip2").join("release");
    let target_release_p1 = root.join("target").join("wasm32-wasip1").join("release");
    let component_release = root.join("target").join("wasm32-wasip2").join("release").join("component");
    for dir in [&target_release, &target_release_p1, &component_release] {
        if !dir.exists() {
            continue;
        }
        if !expected_basename.is_empty() {
            let direct = dir.join(expected_basename);
            if direct.exists() {
                return Some(direct);
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("wasm") {
                    return Some(p);
                }
            }
        }
    }
    let direct = root.join(expected_basename);
    if direct.exists() {
        return Some(direct);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;

    fn make_test_zip(plugin_json: &str, wasm_bytes: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            let options: zip::write::SimpleFileOptions =
                zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.start_file("plugin.json", options).unwrap();
            writer.write_all(plugin_json.as_bytes()).unwrap();
            writer.start_file("main.wasm", options).unwrap();
            writer.write_all(wasm_bytes).unwrap();
            writer.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extract_zip_unpacks_manifest_and_wasm() {
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let zipped = make_test_zip(manifest, &[0, 1, 2, 3]);
        let tmp = tempfile::tempdir().unwrap();
        let manifest_path = extract_zip_bundle(&zipped, tmp.path()).unwrap();
        assert!(manifest_path.exists());
        assert!(tmp.path().join("main.wasm").exists());
        let (raw, parsed) = read_manifest(&manifest_path).unwrap();
        assert_wasm_manifest(&parsed).unwrap();
        assert_eq!(raw["id"], "demo.wasm");
    }

    #[test]
    fn extract_zip_rejects_missing_plugin_json() {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            writer
                .start_file("main.wasm", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        let tmp = tempfile::tempdir().unwrap();
        let err = extract_zip_bundle(&buf, tmp.path()).unwrap_err();
        assert!(err.contains("plugin.json"));
    }

    #[test]
    fn assert_wasm_manifest_rejects_non_wasm() {
        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("frontend".into()),
            wasm_main: None,
            author: None,
            wasm: None,
        };
        assert!(assert_wasm_manifest(&parsed).is_err());
    }

    #[test]
    fn assert_wasm_manifest_requires_wasm_main_and_api_version() {
        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("wasm".into()),
            wasm_main: None,
            author: None,
            wasm: Some(PartialWasmBlock {
                api_version: "0.1.0".into(),
            }),
        };
        assert!(assert_wasm_manifest(&parsed).unwrap_err().contains("wasmMain"));
        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("wasm".into()),
            wasm_main: Some("main.wasm".into()),
            author: None,
            wasm: None,
        };
        assert!(assert_wasm_manifest(&parsed).unwrap_err().contains("apiVersion"));
    }

    #[test]
    fn verify_detached_round_trip() {
        let mut seed = [0u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = i as u8;
        }
        let sk = SigningKey::from_bytes(&seed);
        let vk: VerifyingKey = (&sk).into();
        let pk_b64 = b64().encode(vk.to_bytes());

        let payload = b"-- bundle --";
        let sig: Signature = sk.sign(payload);
        let sig_b64 = b64().encode(sig.to_bytes());

        verify_detached(payload, &sig_b64, &pk_b64).expect("verifies");
        let err = verify_detached(b"-- tampered --", &sig_b64, &pk_b64).unwrap_err();
        assert!(err.contains("signature verification failed"));
    }

    #[test]
    fn find_wasm_artifact_finds_release_output() {
        let tmp = tempfile::tempdir().unwrap();
        let release = tmp.path().join("target").join("wasm32-wasip2").join("release");
        std::fs::create_dir_all(&release).unwrap();
        std::fs::write(release.join("demo.wasm"), b"fake").unwrap();
        let found = find_wasm_artifact(tmp.path(), "demo.wasm").unwrap();
        assert!(found.ends_with("demo.wasm"));
    }

    #[test]
    fn find_plugin_manifest_supports_root_and_nested() {
        let tmp = tempfile::tempdir().unwrap();
        // Root case.
        let root_manifest = tmp.path().join("plugin.json");
        std::fs::write(&root_manifest, "{}").unwrap();
        assert_eq!(find_plugin_manifest(tmp.path()), Some(root_manifest));

        // Nested case (remove root, add nested dir).
        std::fs::remove_file(tmp.path().join("plugin.json")).unwrap();
        let nested = tmp.path().join("manifest");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("plugin.json"), "{}").unwrap();
        let found = find_plugin_manifest(tmp.path()).unwrap();
        assert!(found.ends_with("plugin.json"));
        assert!(found.to_string_lossy().contains("manifest"));
    }
}
