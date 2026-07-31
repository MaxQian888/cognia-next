//! `cognia plugin embed-version <wasm> <ver>` — manually inject the
//! `cognia:api-version` custom section into a built `.wasm`. Normally run
//! automatically by `cognia plugin build`; exposed standalone for authors
//! patching a prebuilt artifact.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

use crate::engine::packaging;
use crate::shared::{looks_like_semver, JsonFailureExit};
use crate::ui::RuntimeUi;

pub(crate) fn run(
    wasm: PathBuf,
    version: String,
    out: Option<PathBuf>,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let input = wasm.display().to_string();
    let dest = out.unwrap_or_else(|| wasm.clone());
    if !looks_like_semver(&version) {
        let err = anyhow!("--version must be MAJOR.MINOR.PATCH (got `{version}`)");
        if ui.flags.json {
            return emit_json_failure(&input, &dest, &version, "input", err);
        }
        return Err(err);
    }
    let bytes = match std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display())) {
        Ok(bytes) => bytes,
        Err(err) if ui.flags.json => {
            return emit_json_failure(&input, &dest, &version, "read", err);
        }
        Err(err) => return Err(err),
    };
    let patched = match packaging::embed_api_version(&bytes, &version) {
        Ok(patched) => patched,
        Err(err) if ui.flags.json => {
            return emit_json_failure(&input, &dest, &version, "embed", err);
        }
        Err(err) => return Err(err),
    };
    if let Err(err) =
        std::fs::write(&dest, patched).with_context(|| format!("write {}", dest.display()))
    {
        if ui.flags.json {
            return emit_json_failure(&input, &dest, &version, "write", err);
        }
        return Err(err);
    }
    if ui.flags.json {
        let payload = EmbedVersionJsonPayload {
            schema_version: 1,
            ok: true,
            action: "embed-version",
            version,
            input,
            output: dest.display().to_string(),
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!(
            "embedded cognia:api-version = {version} into {}",
            dest.display()
        );
    }
    Ok(())
}

fn emit_json_failure(
    input: &str,
    output: &Path,
    version: &str,
    stage: &'static str,
    err: anyhow::Error,
) -> Result<()> {
    let payload = EmbedVersionFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "embed-version",
        stage,
        version: version.to_string(),
        input: input.to_string(),
        output: output.display().to_string(),
        error: err.to_string(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(JsonFailureExit.into())
}

#[derive(Debug, serde::Serialize)]
struct EmbedVersionJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    version: String,
    input: String,
    output: String,
}

#[derive(Debug, serde::Serialize)]
struct EmbedVersionFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    version: String,
    input: String,
    output: String,
    error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_version_json_payload_is_schema_versioned() {
        let payload = EmbedVersionJsonPayload {
            schema_version: 1,
            ok: true,
            action: "embed-version",
            version: "1.2.3".into(),
            input: "input.wasm".into(),
            output: "output.wasm".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "embed-version");
        assert_eq!(json["version"], "1.2.3");
        assert_eq!(json["input"], "input.wasm");
        assert_eq!(json["output"], "output.wasm");
    }
}
