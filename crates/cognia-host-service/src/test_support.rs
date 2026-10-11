//! Host installs and archives for tests, laid out the way
//! `scripts/build/package-host-archive.mjs` writes them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::install_home::{sha256_file, HostManifest, MANIFEST_FILE};

/// The contract hash every test install names.
pub const TEST_CATALOG_HASH: &str =
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/// A complete install directory for `version`, manifest and all.
pub fn write_install(root: &Path, version: &str, target: &str) {
    let files = [
        ("bin/cognia-server", format!("server {version}")),
        ("node/bin/node", "node".to_owned()),
        ("brain/cli.mjs", format!("brain {version}")),
        ("brain/sidecar/claude-host.mjs", "sidecar".to_owned()),
    ];
    let mut hashes = BTreeMap::new();
    for (path, body) in &files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("parent")).expect("create");
        std::fs::write(&full, body).expect("write");
        hashes.insert(
            (*path).to_owned(),
            hex::encode(Sha256::digest(body.as_bytes())),
        );
    }
    let manifest = HostManifest {
        format: 1,
        version: version.to_owned(),
        target: target.to_owned(),
        node_version: Some("24.0.0".into()),
        contract_version: Some(3),
        catalog_hash: Some(TEST_CATALOG_HASH.into()),
        files: hashes,
    };
    std::fs::write(
        root.join(MANIFEST_FILE),
        serde_json::to_vec(&manifest).expect("manifest"),
    )
    .expect("write manifest");
}

/// `cognia-host-<version>-<target>.tar.gz` in `dir`, after `edit` touched the
/// install. Returns the archive and its sha256.
pub fn write_archive(
    dir: &Path,
    version: &str,
    target: &str,
    edit: impl FnOnce(&Path),
) -> (PathBuf, String) {
    let top = format!("cognia-host-{version}-{target}");
    let source = dir.join(format!("src-{version}"));
    write_install(&source.join(&top), version, target);
    edit(&source.join(&top));
    let archive = dir.join(format!("{top}.tar.gz"));
    let file = std::fs::File::create(&archive).expect("archive");
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        file,
        flate2::Compression::fast(),
    ));
    builder
        .append_dir_all(&top, source.join(&top))
        .expect("append");
    builder.into_inner().expect("tar").finish().expect("gzip");
    let sha = sha256_file(&archive).expect("sha");
    (archive, sha)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_test_install_carries_a_manifest_that_verifies() {
        let tmp = tempfile::tempdir().unwrap();
        write_install(tmp.path(), "1.4.0", "darwin-arm64");
        let manifest = HostManifest::read(tmp.path()).unwrap();
        assert_eq!(
            (manifest.version.as_str(), manifest.target.as_str()),
            ("1.4.0", "darwin-arm64")
        );
        assert_eq!(manifest.catalog_hash.as_deref(), Some(TEST_CATALOG_HASH));
        manifest.verify_files(tmp.path()).unwrap();
    }

    #[test]
    fn an_archive_names_its_sha_and_carries_the_edit() {
        let tmp = tempfile::tempdir().unwrap();
        let (archive, sha) = write_archive(tmp.path(), "1.5.0", "darwin-arm64", |root| {
            std::fs::write(root.join("extra.txt"), "edited").unwrap();
        });
        assert!(archive.ends_with("cognia-host-1.5.0-darwin-arm64.tar.gz"));
        assert_eq!(sha256_file(&archive).unwrap(), sha);
        assert!(tmp
            .path()
            .join("src-1.5.0/cognia-host-1.5.0-darwin-arm64/extra.txt")
            .is_file());
    }
}
