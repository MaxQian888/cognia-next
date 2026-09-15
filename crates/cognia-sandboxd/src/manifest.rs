//! `bundle-manifest.json`: what one agent bundle contains (ADR-0183).
//!
//! Written by the bundle build from `deploy/bundle/agent-versions.json`
//! (`scripts/build/bundle-agent-versions.mjs manifest`), read by `probe` to say
//! which runtimes and commands the probed image can host. Drivers read that
//! answer back to refuse the rest with a reason and to turn a spawn's command
//! into the bundled file it runs. The bundle and this binary ship in the same
//! image, so the format is closed: an unknown field is a build bug.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use std::str::FromStr;

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

use crate::layout::Libc;

pub const MANIFEST_VERSION: u32 = 1;

/// The oldest glibc the bundled Node supports (ADR-0183).
pub const DEFAULT_MIN_GLIBC: GlibcVersion = GlibcVersion {
    major: 2,
    minor: 28,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleManifest {
    pub version: u32,
    pub release_tag: String,
    /// The oldest glibc the glibc tree runs on.
    pub min_glibc: GlibcVersion,
    pub runtimes: Vec<BundleRuntime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleRuntime {
    /// The id used across Cognia (`protocol/external-agent-runtimes.json`).
    pub id: String,
    /// The pinned CLI version inside this bundle.
    pub version: String,
    /// Which libc trees carry a build of it. A runtime missing one is refused
    /// on images of that libc rather than attempted.
    pub libc: Vec<Libc>,
    /// A glibc floor above the bundle's own, for a vendor binary built against
    /// a newer glibc. Written per architecture: each platform of the bundle
    /// image carries its own manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_glibc: Option<GlibcVersion>,
    /// The commands this runtime puts under `<libc>/bin/`.
    pub commands: Vec<BundleCommand>,
}

/// One executable in a libc tree's `bin/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleCommand {
    /// The file name under `<libc>/bin/`, which is also the bare command a
    /// spawn names.
    pub name: String,
    /// The npm package that provides it, so a spawn written as
    /// `npx -y <package>` runs the pinned copy instead of downloading one.
    /// Absent for vendor binaries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

/// A bare executable name: what `<libc>/bin/` may contain.
pub fn is_valid_command_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// An npm package name, scoped or not.
fn is_valid_package_name(name: &str) -> bool {
    let segment = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'.' | b'_' | b'-' | b'~')
            })
    };
    if name.is_empty() || name.len() > 214 {
        return false;
    }
    match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, package)| segment(scope) && segment(package)),
        None => segment(name),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("cannot read {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("bundle manifest is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("bundle manifest is invalid: {0}")]
    Invalid(String),
}

impl BundleManifest {
    pub fn load(path: &Path) -> Result<Self, ManifestError> {
        let bytes = std::fs::read(path).map_err(|source| ManifestError::Read {
            path: path.display().to_string(),
            source,
        })?;
        Self::parse(&bytes)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let manifest: BundleManifest = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.version != MANIFEST_VERSION {
            return Err(ManifestError::Invalid(format!(
                "version {} is not supported",
                self.version
            )));
        }
        if self.release_tag.trim().is_empty() || self.release_tag.len() > 128 {
            return Err(ManifestError::Invalid(
                "releaseTag must be 1-128 characters".into(),
            ));
        }
        let mut ids = BTreeSet::new();
        // A command two runtimes share (opencode's two surfaces) is one file
        // in the tree, so both must mean the same package.
        let mut packages: BTreeMap<&str, Option<&str>> = BTreeMap::new();
        for runtime in &self.runtimes {
            if runtime.id.is_empty()
                || !runtime
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                return Err(ManifestError::Invalid(format!(
                    "runtime id {:?} must be lowercase letters, digits and dashes",
                    runtime.id
                )));
            }
            if !ids.insert(runtime.id.as_str()) {
                return Err(ManifestError::Invalid(format!(
                    "runtime {} is listed twice",
                    runtime.id
                )));
            }
            if runtime.version.trim().is_empty() {
                return Err(ManifestError::Invalid(format!(
                    "runtime {} has no version",
                    runtime.id
                )));
            }
            if runtime.libc.is_empty() {
                return Err(ManifestError::Invalid(format!(
                    "runtime {} is built for no libc",
                    runtime.id
                )));
            }
            if let Some(floor) = runtime.min_glibc {
                if !runtime.libc.contains(&Libc::Glibc) {
                    return Err(ManifestError::Invalid(format!(
                        "runtime {} sets minGlibc without a glibc build",
                        runtime.id
                    )));
                }
                if floor <= self.min_glibc {
                    return Err(ManifestError::Invalid(format!(
                        "runtime {} sets minGlibc {floor}, not above the bundle's {}",
                        runtime.id, self.min_glibc
                    )));
                }
            }
            if runtime.commands.is_empty() {
                return Err(ManifestError::Invalid(format!(
                    "runtime {} installs no command",
                    runtime.id
                )));
            }
            let mut names = BTreeSet::new();
            for command in &runtime.commands {
                if !is_valid_command_name(&command.name) {
                    return Err(ManifestError::Invalid(format!(
                        "runtime {} command {:?} is not a bare executable name",
                        runtime.id, command.name
                    )));
                }
                if !names.insert(command.name.as_str()) {
                    return Err(ManifestError::Invalid(format!(
                        "runtime {} lists command {} twice",
                        runtime.id, command.name
                    )));
                }
                if let Some(package) = &command.package {
                    if !is_valid_package_name(package) {
                        return Err(ManifestError::Invalid(format!(
                            "runtime {} command {} names the invalid package {package:?}",
                            runtime.id, command.name
                        )));
                    }
                }
                let package = command.package.as_deref();
                match packages.get(command.name.as_str()) {
                    Some(listed) if *listed != package => {
                        return Err(ManifestError::Invalid(format!(
                            "command {} is provided by different packages",
                            command.name
                        )));
                    }
                    _ => {
                        packages.insert(&command.name, package);
                    }
                }
            }
        }
        Ok(())
    }

    /// Commands this bundle can run on an image with `libc`: those of
    /// [`Self::runtimes_for`], each name once, in manifest order.
    pub fn commands_for(&self, libc: Libc, glibc: Option<GlibcVersion>) -> Vec<BundleCommand> {
        let runnable = self.runtimes_for(libc, glibc);
        let mut seen = BTreeSet::new();
        self.runtimes
            .iter()
            .filter(|runtime| runnable.contains(&runtime.id))
            .flat_map(|runtime| runtime.commands.iter())
            .filter(|command| seen.insert(command.name.clone()))
            .cloned()
            .collect()
    }

    /// Runtime ids this bundle can run on an image with `libc`, in manifest
    /// order. `glibc` is the probed glibc release; a runtime with its own
    /// floor is left out when the release is older or unknown.
    pub fn runtimes_for(&self, libc: Libc, glibc: Option<GlibcVersion>) -> Vec<String> {
        self.runtimes
            .iter()
            .filter(|runtime| runtime.libc.contains(&libc))
            .filter(|runtime| match (libc, runtime.min_glibc) {
                (Libc::Glibc, Some(floor)) => glibc.is_some_and(|found| found >= floor),
                _ => true,
            })
            .map(|runtime| runtime.id.clone())
            .collect()
    }
}

/// A glibc release, compared numerically (`2.9 < 2.28`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GlibcVersion {
    pub major: u32,
    pub minor: u32,
}

impl Ord for GlibcVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor).cmp(&(other.major, other.minor))
    }
}

impl PartialOrd for GlibcVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for GlibcVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

impl FromStr for GlibcVersion {
    type Err = String;

    /// `2.28`; a patch component (`2.28.1`) is accepted and ignored.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let mut parts = value.split('.');
        let parse = |part: Option<&str>| -> Result<u32, String> {
            let part = part.ok_or_else(|| format!("{value:?} is not a glibc version"))?;
            if part.is_empty() || part.len() > 4 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!("{value:?} is not a glibc version"));
            }
            part.parse()
                .map_err(|_| format!("{value:?} is not a glibc version"))
        };
        let major = parse(parts.next())?;
        let minor = parse(parts.next())?;
        if let Some(patch) = parts.next() {
            parse(Some(patch))?;
        }
        if parts.next().is_some() {
            return Err(format!("{value:?} is not a glibc version"));
        }
        Ok(GlibcVersion { major, minor })
    }
}

impl Serialize for GlibcVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for GlibcVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "releaseTag": "v1.2.0",
            "minGlibc": "2.28",
            "runtimes": [
                {
                    "id": "claude-code", "version": "2.1.3", "libc": ["glibc", "musl"],
                    "commands": [
                        { "name": "claude-agent-acp", "package": "@agentclientprotocol/claude-agent-acp" },
                        { "name": "claude", "package": "@anthropic-ai/claude-code" }
                    ]
                },
                {
                    "id": "gemini-cli", "version": "0.9.0", "libc": ["glibc"],
                    "commands": [{ "name": "gemini", "package": "@google/gemini-cli" }]
                },
                {
                    "id": "codex", "version": "0.52.0", "libc": ["musl", "glibc"],
                    "commands": [{ "name": "codex-acp", "package": "@agentclientprotocol/codex-acp" }]
                },
                {
                    "id": "kiro-cli", "version": "2.21.4", "libc": ["glibc", "musl"], "minGlibc": "2.34",
                    "commands": [{ "name": "kiro-cli" }]
                }
            ]
        })
    }

    fn runtime(id: &str, commands: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "id": id, "version": "1", "libc": ["glibc"], "commands": commands })
    }

    #[test]
    fn lists_the_commands_an_image_can_run() {
        let manifest = BundleManifest::parse(sample().to_string().as_bytes()).unwrap();
        let names = |commands: Vec<BundleCommand>| {
            commands
                .into_iter()
                .map(|command| command.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(manifest.commands_for(Libc::Musl, None)),
            ["claude-agent-acp", "claude", "codex-acp", "kiro-cli"]
        );
        // The glibc floor that drops a runtime drops its commands with it.
        assert_eq!(
            names(manifest.commands_for(Libc::Glibc, Some("2.31".parse().unwrap()))),
            ["claude-agent-acp", "claude", "gemini", "codex-acp"]
        );
        assert_eq!(
            manifest.commands_for(Libc::Musl, None)[2]
                .package
                .as_deref(),
            Some("@agentclientprotocol/codex-acp")
        );
    }

    #[test]
    fn a_command_shared_by_two_runtimes_is_listed_once_and_must_agree() {
        let mut shared = sample();
        shared["runtimes"] = serde_json::json!([
            runtime(
                "opencode",
                serde_json::json!([{ "name": "opencode", "package": "opencode-ai" }])
            ),
            runtime(
                "opencode-acp",
                serde_json::json!([{ "name": "opencode", "package": "opencode-ai" }])
            ),
        ]);
        let manifest = BundleManifest::parse(shared.to_string().as_bytes()).unwrap();
        assert_eq!(manifest.commands_for(Libc::Glibc, None).len(), 1);

        shared["runtimes"][1]["commands"][0]["package"] = "opencode-fork".into();
        assert!(matches!(
            BundleManifest::parse(shared.to_string().as_bytes()),
            Err(ManifestError::Invalid(message)) if message.contains("different packages")
        ));
    }

    #[test]
    fn refuses_commands_that_are_not_bare_names_or_real_packages() {
        for commands in [
            serde_json::json!([]),
            serde_json::json!([{ "name": "../bin/sh" }]),
            serde_json::json!([{ "name": "-flag" }]),
            serde_json::json!([{ "name": "claude" }, { "name": "claude" }]),
            serde_json::json!([{ "name": "claude", "package": "Not A Package" }]),
            serde_json::json!([{ "name": "claude", "package": "@scope" }]),
        ] {
            let mut manifest = sample();
            manifest["runtimes"] = serde_json::json!([runtime("a", commands.clone())]);
            assert!(
                matches!(
                    BundleManifest::parse(manifest.to_string().as_bytes()),
                    Err(ManifestError::Invalid(_))
                ),
                "{commands} should be refused"
            );
        }
        let mut missing = sample();
        missing["runtimes"][0]
            .as_object_mut()
            .unwrap()
            .remove("commands");
        assert!(matches!(
            BundleManifest::parse(missing.to_string().as_bytes()),
            Err(ManifestError::Json(_))
        ));
    }

    #[test]
    fn parses_and_filters_runtimes_by_libc_and_glibc_floor() {
        let manifest = BundleManifest::parse(sample().to_string().as_bytes()).unwrap();
        let glibc = |text: &str| Some(text.parse::<GlibcVersion>().unwrap());
        assert_eq!(manifest.min_glibc, DEFAULT_MIN_GLIBC);
        assert_eq!(
            manifest.runtimes_for(Libc::Glibc, glibc("2.36")),
            ["claude-code", "gemini-cli", "codex", "kiro-cli"]
        );
        assert_eq!(
            manifest.runtimes_for(Libc::Glibc, glibc("2.31")),
            ["claude-code", "gemini-cli", "codex"]
        );
        assert_eq!(
            manifest.runtimes_for(Libc::Glibc, None),
            ["claude-code", "gemini-cli", "codex"]
        );
        // The floor is a glibc floor; the musl build does not carry it.
        assert_eq!(
            manifest.runtimes_for(Libc::Musl, None),
            ["claude-code", "codex", "kiro-cli"]
        );
        let round_trip = serde_json::to_value(&manifest).unwrap();
        assert_eq!(round_trip, sample());
    }

    #[test]
    fn refuses_a_runtime_glibc_floor_that_means_nothing() {
        let commands = serde_json::json!([{ "name": "a" }]);
        for runtime in [
            serde_json::json!({ "id": "a", "version": "1", "libc": ["musl"], "minGlibc": "2.34", "commands": commands }),
            serde_json::json!({ "id": "a", "version": "1", "libc": ["glibc"], "minGlibc": "2.28", "commands": commands }),
        ] {
            let mut manifest = sample();
            manifest["runtimes"] = serde_json::json!([runtime]);
            assert!(matches!(
                BundleManifest::parse(manifest.to_string().as_bytes()),
                Err(ManifestError::Invalid(_))
            ));
        }
    }

    #[test]
    fn refuses_unknown_fields_and_invalid_entries() {
        let mut unknown = sample();
        unknown["signature"] = "x".into();
        assert!(matches!(
            BundleManifest::parse(unknown.to_string().as_bytes()),
            Err(ManifestError::Json(_))
        ));

        let cases: [(&str, serde_json::Value); 5] = [
            ("version", serde_json::json!(2)),
            ("releaseTag", serde_json::json!(" ")),
            (
                "runtimes",
                serde_json::json!([{ "id": "Claude", "version": "1", "libc": ["glibc"], "commands": [{ "name": "a" }] }]),
            ),
            (
                "runtimes",
                serde_json::json!([
                    { "id": "a", "version": "1", "libc": ["glibc"], "commands": [{ "name": "a" }] },
                    { "id": "a", "version": "2", "libc": ["musl"], "commands": [{ "name": "a" }] }
                ]),
            ),
            (
                "runtimes",
                serde_json::json!([{ "id": "a", "version": "1", "libc": [], "commands": [{ "name": "a" }] }]),
            ),
        ];
        for (field, value) in cases {
            let mut manifest = sample();
            manifest[field] = value;
            assert!(
                matches!(
                    BundleManifest::parse(manifest.to_string().as_bytes()),
                    Err(ManifestError::Invalid(_))
                ),
                "{field} should be refused"
            );
        }
    }

    #[test]
    fn glibc_versions_compare_numerically() {
        let parse = |text: &str| text.parse::<GlibcVersion>().unwrap();
        assert!(parse("2.9") < parse("2.28"));
        assert!(parse("2.17") < DEFAULT_MIN_GLIBC);
        assert!(parse("2.28.1") >= DEFAULT_MIN_GLIBC);
        assert_eq!(parse("2.36").to_string(), "2.36");
        for bad in ["2", "2.", "x.28", "2.28.1.4", "", "2.-1", "99999.1"] {
            assert!(bad.parse::<GlibcVersion>().is_err(), "{bad}");
        }
    }
}
