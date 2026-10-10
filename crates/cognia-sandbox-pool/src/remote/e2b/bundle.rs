//! The agent bundle's root filesystem, as one archive E2B's template build
//! can `COPY` (ADR-0221 D4).
//!
//! E2B builds a template from the user's image; it cannot mount the bundle
//! image beside it as Docker and Kubernetes do. So the Host fetches the
//! bundle by digest — the linux/amd64 manifest of its index, every layer
//! verified against its descriptor — and flattens the layers into the tree
//! they describe, as an overlay filesystem would: a later layer's entry
//! replaces an earlier one, a whiteout (`.wh.<name>`) deletes from the layers
//! below, an opaque marker (`.wh..wh..opq`) empties a directory of them.
//!
//! The result is one gzip tar of `opt/cognia/…` — the build's `COPY`
//! extracts it with `tar -xz` and merges `opt/cognia` into `/opt/cognia` — so
//! it is uploaded once per bundle digest through E2B's content-addressed file
//! cache. Nothing outside `opt/cognia` is carried: the bundle image is
//! `FROM scratch` with that one tree, and the build copies only it.
//!
//! The layers are read straight from their downloaded blobs and never
//! extracted to the Host's filesystem: a case-insensitive Host filesystem
//! would merge paths the sandbox keeps apart, and an unprivileged Host could
//! not reproduce ownership. Entries keep their mode, owner and timestamps;
//! extended attributes are not carried (the bundle needs none), and special
//! files are refused, as `cognia-sandboxd install` refuses them.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use cognia_environment::image::{ImageReference, PinnedImage};
use cognia_environment::registry::http::ReqwestTransport;
use cognia_environment::registry::manifest::Descriptor;
use cognia_environment::registry::{
    Platform, RegistryClient, RegistryCredential, RegistryCredentials, RegistryEndpoint,
    RegistryError,
};
use cognia_external_agent::container_backend::RegistryAuth;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

/// The tree the archive carries, relative to the build context.
pub(super) const BUNDLE_TREE: &str = "opt/cognia";
/// The supervisor; a bundle without it cannot run anything.
const SUPERVISOR: &str = "opt/cognia/bin/cognia-sandboxd";
/// E2B runs x86-64 Firecracker microVMs.
const E2B_ARCHITECTURE: &str = "amd64";
const WHITEOUT_PREFIX: &str = ".wh.";
const OPAQUE_MARKER: &str = ".wh..wh..opq";

/// Where the bundle comes from and how to authenticate.
#[derive(Clone, Debug)]
pub(super) struct BundleSource {
    pub image: PinnedImage,
    pub auth: Option<RegistryAuth>,
    /// Plain HTTP to the bundle registry; only a loopback test registry.
    pub insecure: bool,
}

/// The flattened archive, deleted with its directory when dropped.
pub(super) struct RootfsArchive {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
    pub size: u64,
}

/// What is wrong with the bundle, and whether retrying could help.
#[derive(Debug)]
pub(super) enum BundleError {
    Registry(RegistryError),
    /// The bundle's content cannot be injected.
    Invalid(String),
    /// The Host's own temporary storage failed.
    Io(String),
}

impl BundleError {
    pub(super) fn into_spawn_error(self, image: &PinnedImage) -> SandboxSpawnError {
        let reference = image.canonical();
        match self {
            Self::Registry(RegistryError::DigestMismatch { expected, actual }) => {
                SandboxSpawnError::refused(
                    "sandbox_bundle_digest_mismatch",
                    format!(
                        "the agent bundle {reference} served {actual} where {expected} was pinned"
                    ),
                )
            }
            Self::Registry(error) if error.is_transient() => SandboxSpawnError::fault(
                "sandbox_bundle_unavailable",
                format!("fetching the agent bundle {reference}: {error}"),
            ),
            Self::Registry(error) => SandboxSpawnError::refused(
                "sandbox_bundle_unavailable",
                format!(
                    "fetching the agent bundle {reference} ({}): {error}",
                    error.code()
                ),
            ),
            Self::Invalid(message) => SandboxSpawnError::refused(
                "sandbox_bundle_invalid",
                format!("the agent bundle {reference} cannot be injected: {message}"),
            ),
            Self::Io(message) => SandboxSpawnError::fault(
                "sandbox_bundle_unavailable",
                format!("staging the agent bundle {reference}: {message}"),
            ),
        }
    }
}

impl From<RegistryError> for BundleError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}

fn io(context: &str, error: impl std::fmt::Display) -> BundleError {
    BundleError::Io(format!("{context}: {error}"))
}

/// The registry credential a driver-provided `RegistryAuth` stands for.
fn credential(auth: &RegistryAuth) -> Option<RegistryCredential> {
    let non_empty = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    if let Some(token) = non_empty(&auth.registry_token) {
        return Some(RegistryCredential::RegistryToken(token));
    }
    if let Some(token) = non_empty(&auth.identity_token) {
        return Some(RegistryCredential::IdentityToken(token));
    }
    match (non_empty(&auth.username), non_empty(&auth.password)) {
        (Some(username), Some(password)) => Some(RegistryCredential::Basic { username, password }),
        _ => None,
    }
}

/// How a layer blob is compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LayerFormat {
    Tar,
    Gzip,
}

/// The layer media types a rootfs can be built from.
fn layer_format(descriptor: &Descriptor) -> Result<Option<LayerFormat>, BundleError> {
    let Some(media_type) = descriptor.media_type.as_deref() else {
        // Optional in OCI; the content decides.
        return Ok(None);
    };
    match media_type {
        "application/vnd.oci.image.layer.v1.tar"
        | "application/vnd.oci.image.layer.nondistributable.v1.tar"
        | "application/vnd.docker.image.rootfs.diff.tar" => Ok(Some(LayerFormat::Tar)),
        "application/vnd.oci.image.layer.v1.tar+gzip"
        | "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"
        | "application/vnd.docker.image.rootfs.diff.tar.gzip"
        | "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip" => {
            Ok(Some(LayerFormat::Gzip))
        }
        other if other.contains("zstd") => Err(BundleError::Invalid(format!(
            "layer {} is zstd-compressed ({other}); publish the bundle with gzip layers",
            descriptor.digest
        ))),
        other => Err(BundleError::Invalid(format!(
            "layer {} has media type {other}, which is not a filesystem layer",
            descriptor.digest
        ))),
    }
}

/// Fetches `source` and writes its flattened `opt/cognia` tree to a gzip tar
/// in a fresh temporary directory.
pub(super) async fn prepare_rootfs(source: &BundleSource) -> Result<RootfsArchive, BundleError> {
    let mut credentials = RegistryCredentials::empty();
    if let Some(credential) = source.auth.as_ref().and_then(credential) {
        credentials = credentials.with_credential(&source.image.registry, credential);
    }
    let client = RegistryClient::new(ReqwestTransport::default(), credentials);
    let endpoint = RegistryEndpoint {
        registry: source.image.registry.clone(),
        insecure: source.insecure,
    };
    let reference = ImageReference {
        registry: source.image.registry.clone(),
        repository: source.image.repository.clone(),
        tag: None,
        digest: Some(source.image.digest.clone()),
    };
    let dir = tempfile::Builder::new()
        .prefix("cognia-e2b-bundle-")
        .tempdir()
        .map_err(|error| io("creating a staging directory", error))?;

    let mut layers = client
        .open_layers(&endpoint, &reference, &Platform::linux(E2B_ARCHITECTURE))
        .await?;
    let descriptors = layers.layers().to_vec();
    if descriptors.is_empty() {
        return Err(BundleError::Invalid("the image has no layers".into()));
    }
    let mut blobs = Vec::with_capacity(descriptors.len());
    for (index, descriptor) in descriptors.iter().enumerate() {
        let declared = layer_format(descriptor)?;
        let path = dir.path().join(format!("layer-{index}"));
        let file = File::create(&path).map_err(|error| io("creating a layer file", error))?;
        let mut sink = BufWriter::new(file);
        layers.fetch_blob(descriptor, &mut sink).await?;
        // A scratch file read back moments later: flushed, not fsynced.
        sink.into_inner()
            .map_err(|error| io("writing a layer file", error.error()))?;
        blobs.push(LayerBlob {
            path,
            digest: descriptor.digest.clone(),
            declared,
        });
    }

    let output = dir.path().join("rootfs.tar.gz");
    let written = output.clone();
    let size = tokio::task::spawn_blocking(move || flatten(&blobs, &written))
        .await
        .map_err(|error| io("flattening the layers", error))??;
    Ok(RootfsArchive {
        _dir: dir,
        path: output,
        size,
    })
}

/// One downloaded, verified layer.
#[derive(Debug, Clone)]
pub(super) struct LayerBlob {
    pub path: PathBuf,
    pub digest: String,
    /// From the media type; `None` means sniff the gzip magic.
    pub declared: Option<LayerFormat>,
}

fn open_layer(blob: &LayerBlob) -> Result<tar::Archive<Box<dyn Read>>, BundleError> {
    let mut file = File::open(&blob.path).map_err(|error| io("opening a layer", error))?;
    let format = match blob.declared {
        Some(format) => format,
        None => {
            let mut magic = [0u8; 2];
            let read = file
                .read(&mut magic)
                .map_err(|error| io("reading a layer", error))?;
            file.seek(SeekFrom::Start(0))
                .map_err(|error| io("reading a layer", error))?;
            if read == 2 && magic == [0x1f, 0x8b] {
                LayerFormat::Gzip
            } else {
                LayerFormat::Tar
            }
        }
    };
    let reader: Box<dyn Read> = match format {
        LayerFormat::Tar => Box::new(BufReader::new(file)),
        LayerFormat::Gzip => Box::new(GzDecoder::new(BufReader::new(file))),
    };
    Ok(tar::Archive::new(reader))
}

/// A path as the overlay sees it: relative, `/`-joined, no `.` or `..`.
/// `Ok(None)` for the archive root itself.
fn normalize(path: &Path, digest: &str) -> Result<Option<String>, BundleError> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or_else(|| {
                BundleError::Invalid(format!("layer {digest} has a path that is not UTF-8"))
            })?),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(BundleError::Invalid(format!(
                    "layer {digest} has an entry outside its root: {}",
                    path.display()
                )))
            }
        }
    }
    Ok((!parts.is_empty()).then(|| parts.join("/")))
}

/// Whether `path` is carried: the tree itself, below it, or a parent of it.
fn carried(path: &str) -> bool {
    path == "opt" || path == BUNDLE_TREE || path.starts_with(&format!("{BUNDLE_TREE}/"))
}

fn descendant_prefix(path: &str) -> String {
    format!("{path}/")
}

/// The layer an entry of the flattened tree comes from, and its position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Origin {
    layer: usize,
    entry: usize,
    directory: bool,
    regular: bool,
}

/// Removes `path` (when `including_self`) and everything below it that a
/// layer below `layer` contributed.
fn remove_lower(
    kept: &mut BTreeMap<String, Origin>,
    path: &str,
    layer: usize,
    including_self: bool,
) {
    if including_self && kept.get(path).is_some_and(|origin| origin.layer < layer) {
        kept.remove(path);
    }
    let prefix = descendant_prefix(path);
    let doomed: Vec<String> = kept
        .range(prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&prefix))
        .filter(|(_, origin)| origin.layer < layer)
        .map(|(key, _)| key.clone())
        .collect();
    for key in doomed {
        kept.remove(&key);
    }
}

/// Pass one: which entry of which layer each path of the final tree is.
fn plan(blobs: &[LayerBlob]) -> Result<BTreeMap<String, Origin>, BundleError> {
    let mut kept: BTreeMap<String, Origin> = BTreeMap::new();
    for (layer, blob) in blobs.iter().enumerate() {
        let mut archive = open_layer(blob)?;
        let entries = archive
            .entries()
            .map_err(|error| BundleError::Invalid(format!("layer {}: {error}", blob.digest)))?;
        for (index, entry) in entries.enumerate() {
            let entry = entry
                .map_err(|error| BundleError::Invalid(format!("layer {}: {error}", blob.digest)))?;
            let kind = entry.header().entry_type();
            if matches!(kind, tar::EntryType::XGlobalHeader) {
                continue;
            }
            let raw = entry
                .path()
                .map_err(|error| BundleError::Invalid(format!("layer {}: {error}", blob.digest)))?
                .into_owned();
            let Some(path) = normalize(&raw, &blob.digest)? else {
                continue;
            };
            let (parent, name) = match path.rsplit_once('/') {
                Some((parent, name)) => (Some(parent), name),
                None => (None, path.as_str()),
            };
            if name == OPAQUE_MARKER {
                if let Some(parent) = parent.filter(|parent| carried(parent)) {
                    remove_lower(&mut kept, parent, layer, false);
                }
                continue;
            }
            if let Some(hidden) = name.strip_prefix(WHITEOUT_PREFIX) {
                let target = match parent {
                    Some(parent) => format!("{parent}/{hidden}"),
                    None => hidden.to_string(),
                };
                if carried(&target) {
                    remove_lower(&mut kept, &target, layer, true);
                }
                continue;
            }
            if !carried(&path) {
                continue;
            }
            let (directory, regular) = match kind {
                tar::EntryType::Directory => (true, false),
                tar::EntryType::Regular | tar::EntryType::Continuous => (false, true),
                tar::EntryType::Symlink | tar::EntryType::Link => (false, false),
                other => {
                    return Err(BundleError::Invalid(format!(
                        "layer {} has a special file {path} ({other:?})",
                        blob.digest
                    )))
                }
            };
            if !directory {
                // A file over a lower directory hides everything inside it.
                remove_lower(&mut kept, &path, layer, false);
            }
            kept.insert(
                path,
                Origin {
                    layer,
                    entry: index,
                    directory,
                    regular,
                },
            );
        }
    }
    if !kept.get(SUPERVISOR).is_some_and(|origin| origin.regular) {
        return Err(BundleError::Invalid(format!("it has no /{SUPERVISOR}")));
    }
    Ok(kept)
}

/// Pass two: the planned entries, in layer order, into a gzip tar at
/// `output`. Returns its size.
pub(super) fn flatten(blobs: &[LayerBlob], output: &Path) -> Result<u64, BundleError> {
    let kept = plan(blobs)?;
    let file = File::create(output).map_err(|error| io("creating the archive", error))?;
    let encoder = GzEncoder::new(BufWriter::new(file), Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut emitted: HashSet<String> = HashSet::new();
    for (layer, blob) in blobs.iter().enumerate() {
        let mut archive = open_layer(blob)?;
        let entries = archive
            .entries()
            .map_err(|error| BundleError::Invalid(format!("layer {}: {error}", blob.digest)))?;
        for (index, entry) in entries.enumerate() {
            let mut entry = entry
                .map_err(|error| BundleError::Invalid(format!("layer {}: {error}", blob.digest)))?;
            let raw = entry
                .path()
                .map_err(|error| BundleError::Invalid(format!("layer {}: {error}", blob.digest)))?
                .into_owned();
            let Some(path) = normalize(&raw, &blob.digest)? else {
                continue;
            };
            let Some(origin) = kept.get(&path) else {
                continue;
            };
            if origin.layer != layer || origin.entry != index {
                continue;
            }
            let mut header = entry.header().clone();
            let written = match entry.header().entry_type() {
                tar::EntryType::Directory => {
                    header.set_size(0);
                    builder.append_data(&mut header, &path, std::io::empty())
                }
                tar::EntryType::Symlink => {
                    let target = entry
                        .link_name()
                        .map_err(|error| {
                            BundleError::Invalid(format!("layer {}: {error}", blob.digest))
                        })?
                        .ok_or_else(|| {
                            BundleError::Invalid(format!(
                                "layer {} has a symlink {path} without a target",
                                blob.digest
                            ))
                        })?
                        .into_owned();
                    builder.append_link(&mut header, &path, target)
                }
                tar::EntryType::Link => {
                    let target = entry
                        .link_name()
                        .map_err(|error| {
                            BundleError::Invalid(format!("layer {}: {error}", blob.digest))
                        })?
                        .ok_or_else(|| {
                            BundleError::Invalid(format!(
                                "layer {} has a hard link {path} without a target",
                                blob.digest
                            ))
                        })?
                        .into_owned();
                    let target = normalize(&target, &blob.digest)?.unwrap_or_default();
                    if !emitted.contains(&target) || !kept.get(&target).is_some_and(|o| o.regular) {
                        return Err(BundleError::Invalid(format!(
                            "layer {} links {path} to {target}, which the flattened tree does not hold before it",
                            blob.digest
                        )));
                    }
                    builder.append_link(&mut header, &path, &target)
                }
                _ => builder.append_data(&mut header, &path, &mut entry),
            };
            written.map_err(|error| io("writing the archive", error))?;
            emitted.insert(path);
        }
    }
    let encoder = builder
        .into_inner()
        .map_err(|error| io("finishing the archive", error))?;
    let writer = encoder
        .finish()
        .map_err(|error| io("finishing the archive", error))?;
    writer
        .into_inner()
        .map_err(|error| io("finishing the archive", error.error()))?;
    let size = std::fs::metadata(output)
        .map_err(|error| io("measuring the archive", error))?
        .len();
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{gzip, FakeRegistry, TarEntry};
    use super::*;
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;

    fn layer(dir: &Path, name: &str, entries: &[TarEntry], gzipped: bool) -> LayerBlob {
        let tar = super::super::test_server::tar(entries);
        let bytes = if gzipped { gzip(&tar) } else { tar };
        let path = dir.join(name);
        std::fs::write(&path, &bytes).unwrap();
        LayerBlob {
            path,
            digest: format!("sha256:{name}"),
            declared: None,
        }
    }

    /// `(path, kind, content or link target, mode)` of every entry.
    fn read_archive(path: &Path) -> Vec<(String, tar::EntryType, Vec<u8>, u32)> {
        let file = File::open(path).unwrap();
        let mut archive = tar::Archive::new(GzDecoder::new(file));
        archive
            .entries()
            .unwrap()
            .map(|entry| {
                let mut entry = entry.unwrap();
                let path = entry.path().unwrap().to_string_lossy().to_string();
                let kind = entry.header().entry_type();
                let mode = entry.header().mode().unwrap();
                let mut content = Vec::new();
                if let Some(link) = entry.link_name().unwrap() {
                    content = link.to_string_lossy().as_bytes().to_vec();
                } else {
                    entry.read_to_end(&mut content).unwrap();
                }
                (path, kind, content, mode)
            })
            .collect()
    }

    fn paths(entries: &[(String, tar::EntryType, Vec<u8>, u32)]) -> Vec<&str> {
        entries.iter().map(|(path, ..)| path.as_str()).collect()
    }

    #[test]
    fn layers_flatten_as_an_overlay_would() {
        let dir = tempfile::tempdir().unwrap();
        let base = layer(
            dir.path(),
            "base",
            &[
                TarEntry::dir("./opt/"),
                TarEntry::dir("./opt/cognia/"),
                TarEntry::file("./opt/cognia/bin/cognia-sandboxd", b"old", 0o755),
                TarEntry::file("./opt/cognia/old.txt", b"gone", 0o644),
                TarEntry::file("opt/cognia/musl/a", b"a", 0o644),
                TarEntry::file("opt/cognia/musl/b", b"b", 0o644),
                TarEntry::file("opt/cognia/glibc", b"a file, later a dir", 0o644),
                TarEntry::file("etc/passwd", b"not carried", 0o644),
                TarEntry::dir("opt/cognia/node/"),
                TarEntry::file("opt/cognia/node/lib/x.js", b"hidden later", 0o644),
            ],
            true,
        );
        let top = layer(
            dir.path(),
            "top",
            &[
                TarEntry::file("opt/cognia/bin/cognia-sandboxd", b"new", 0o755),
                TarEntry::file("opt/cognia/.wh.old.txt", b"", 0o644),
                TarEntry::file("opt/cognia/musl/.wh..wh..opq", b"", 0o644),
                TarEntry::file("opt/cognia/musl/c", b"c", 0o600),
                TarEntry::dir("opt/cognia/glibc/"),
                TarEntry::file("opt/cognia/node", b"now a file", 0o644),
                TarEntry::symlink("opt/cognia/current", "bin/cognia-sandboxd"),
                TarEntry::hardlink("opt/cognia/sandboxd-copy", "opt/cognia/bin/cognia-sandboxd"),
            ],
            false,
        );
        let output = dir.path().join("out.tar.gz");
        let size = flatten(&[base, top], &output).unwrap();
        assert_eq!(size, std::fs::metadata(&output).unwrap().len());

        let entries = read_archive(&output);
        let listed = paths(&entries);
        assert!(listed.contains(&"opt/cognia/bin/cognia-sandboxd"));
        assert!(!listed.contains(&"opt/cognia/old.txt"), "whited out");
        assert!(!listed.contains(&"opt/cognia/musl/a"), "opaque directory");
        assert!(!listed.contains(&"opt/cognia/musl/b"));
        assert!(listed.contains(&"opt/cognia/musl/c"));
        assert!(!listed.contains(&"etc/passwd"), "outside the tree");
        assert!(!listed.iter().any(|path| path.contains(".wh.")));
        assert!(
            !listed.contains(&"opt/cognia/node/lib/x.js"),
            "a file over a lower directory hides what was inside it"
        );
        assert!(listed.contains(&"opt/cognia/node"));
        let supervisor = entries
            .iter()
            .find(|(path, ..)| path == "opt/cognia/bin/cognia-sandboxd")
            .unwrap();
        assert_eq!(supervisor.2, b"new");
        assert_eq!(supervisor.3, 0o755);
        let private = entries
            .iter()
            .find(|(path, ..)| path == "opt/cognia/musl/c")
            .unwrap();
        assert_eq!(private.3, 0o600, "modes are kept");
        let link = entries
            .iter()
            .find(|(path, ..)| path == "opt/cognia/current")
            .unwrap();
        assert_eq!(link.1, tar::EntryType::Symlink);
        assert_eq!(link.2, b"bin/cognia-sandboxd");
        let hard = entries
            .iter()
            .find(|(path, ..)| path == "opt/cognia/sandboxd-copy")
            .unwrap();
        assert_eq!(hard.1, tar::EntryType::Link);
        assert_eq!(hard.2, b"opt/cognia/bin/cognia-sandboxd");
        let glibc = entries
            .iter()
            .find(|(path, ..)| path == "opt/cognia/glibc")
            .unwrap();
        assert_eq!(glibc.1, tar::EntryType::Directory);
    }

    #[test]
    fn long_paths_survive_flattening() {
        let dir = tempfile::tempdir().unwrap();
        let long = format!("opt/cognia/glibc/lib/{}/index.js", "deep".repeat(40));
        let only = layer(
            dir.path(),
            "only",
            &[
                TarEntry::file("opt/cognia/bin/cognia-sandboxd", b"x", 0o755),
                TarEntry::file(&long, b"long path", 0o644),
            ],
            true,
        );
        let output = dir.path().join("out.tar.gz");
        flatten(&[only], &output).unwrap();
        let entries = read_archive(&output);
        let found = entries.iter().find(|(path, ..)| *path == long).unwrap();
        assert_eq!(found.2, b"long path");
    }

    #[test]
    fn broken_bundles_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.tar.gz");

        let empty = layer(dir.path(), "empty", &[TarEntry::dir("opt/cognia/")], true);
        let error = flatten(&[empty], &output).unwrap_err();
        assert!(matches!(&error, BundleError::Invalid(m) if m.contains("cognia-sandboxd")));

        let escaping = layer(
            dir.path(),
            "escaping",
            &[TarEntry::file_raw_path("opt/cognia/../../etc/x", b"x")],
            true,
        );
        let error = flatten(&[escaping], &output).unwrap_err();
        assert!(matches!(&error, BundleError::Invalid(m) if m.contains("outside its root")));

        let special = layer(
            dir.path(),
            "special",
            &[
                TarEntry::file("opt/cognia/bin/cognia-sandboxd", b"x", 0o755),
                TarEntry::fifo("opt/cognia/pipe"),
            ],
            true,
        );
        let error = flatten(&[special], &output).unwrap_err();
        assert!(matches!(&error, BundleError::Invalid(m) if m.contains("special file")));

        let dangling = layer(
            dir.path(),
            "dangling",
            &[
                TarEntry::hardlink("opt/cognia/early", "opt/cognia/bin/cognia-sandboxd"),
                TarEntry::file("opt/cognia/bin/cognia-sandboxd", b"x", 0o755),
            ],
            true,
        );
        let error = flatten(&[dangling], &output).unwrap_err();
        assert!(matches!(&error, BundleError::Invalid(m) if m.contains("does not hold")));

        let zstd = Descriptor {
            media_type: Some("application/vnd.oci.image.layer.v1.tar+zstd".into()),
            digest: format!("sha256:{}", "a".repeat(64)),
            size: 1,
            platform: None,
            annotations: BTreeMap::new(),
        };
        assert!(matches!(layer_format(&zstd), Err(BundleError::Invalid(m)) if m.contains("zstd")));
        let artifact = Descriptor {
            media_type: Some("application/vnd.in-toto+json".into()),
            ..zstd.clone()
        };
        assert!(layer_format(&artifact).is_err());
        let plain = Descriptor {
            media_type: Some("application/vnd.docker.image.rootfs.diff.tar.gzip".into()),
            ..zstd
        };
        assert_eq!(layer_format(&plain).unwrap(), Some(LayerFormat::Gzip));
    }

    #[test]
    fn registry_failures_map_to_spawn_outcomes() {
        let image = PinnedImage {
            registry: "ghcr.io".into(),
            repository: "cognia/bundle".into(),
            digest: format!("sha256:{}", "b".repeat(64)),
        };
        let mismatch = BundleError::Registry(RegistryError::DigestMismatch {
            expected: "sha256:x".into(),
            actual: "sha256:y".into(),
        })
        .into_spawn_error(&image);
        assert_eq!(mismatch.code, "sandbox_bundle_digest_mismatch");
        assert_eq!(mismatch.kind, SandboxErrorKind::Refused);

        let transient = BundleError::Registry(RegistryError::Unreachable {
            registry: "ghcr.io".into(),
            message: "reset".into(),
        })
        .into_spawn_error(&image);
        assert_eq!(transient.code, "sandbox_bundle_unavailable");
        assert_eq!(transient.kind, SandboxErrorKind::Fault);

        let denied = BundleError::Registry(RegistryError::Unauthorized {
            registry: "ghcr.io".into(),
        })
        .into_spawn_error(&image);
        assert_eq!(denied.code, "sandbox_bundle_unavailable");
        assert_eq!(denied.kind, SandboxErrorKind::Refused);
        assert!(denied.message.contains("registry_unauthorized"));

        let local = BundleError::Io("disk full".into()).into_spawn_error(&image);
        assert_eq!(local.kind, SandboxErrorKind::Fault);
    }

    #[test]
    fn driver_credentials_become_registry_credentials() {
        let basic = RegistryAuth {
            server_address: "ghcr.io".into(),
            username: Some("bot".into()),
            password: Some("pw".into()),
            ..RegistryAuth::default()
        };
        assert_eq!(
            credential(&basic),
            Some(RegistryCredential::Basic {
                username: "bot".into(),
                password: "pw".into(),
            })
        );
        let token = RegistryAuth {
            registry_token: Some("t".into()),
            ..basic.clone()
        };
        assert_eq!(
            credential(&token),
            Some(RegistryCredential::RegistryToken("t".into()))
        );
        let identity = RegistryAuth {
            identity_token: Some("refresh".into()),
            ..RegistryAuth::default()
        };
        assert_eq!(
            credential(&identity),
            Some(RegistryCredential::IdentityToken("refresh".into()))
        );
        assert_eq!(credential(&RegistryAuth::default()), None);
    }

    #[tokio::test]
    async fn a_pinned_bundle_is_fetched_verified_and_flattened() {
        super::super::test_server::init_network_policy();
        let registry = FakeRegistry::start_bundle(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"#!supervisor",
            0o755,
        )])
        .await;
        let archive = prepare_rootfs(&BundleSource {
            image: registry.image.clone(),
            auth: Some(RegistryAuth {
                server_address: registry.image.registry.clone(),
                username: Some(FakeRegistry::USER.into()),
                password: Some(FakeRegistry::PASSWORD.into()),
                ..RegistryAuth::default()
            }),
            insecure: true,
        })
        .await
        .map_err(|error| format!("{error:?}"))
        .unwrap();
        let entries = read_archive(&archive.path);
        assert_eq!(paths(&entries), vec!["opt/cognia/bin/cognia-sandboxd"]);
        assert_eq!(entries[0].2, b"#!supervisor");
        assert!(
            registry.served_with_auth(),
            "credentials answered the challenge"
        );
        let staged = archive.path.parent().unwrap().to_path_buf();
        drop(archive);
        assert!(
            !staged.exists(),
            "the staging directory goes with the archive"
        );

        let tampered = FakeRegistry::start_tampered_bundle().await;
        let error = prepare_rootfs(&BundleSource {
            image: tampered.image.clone(),
            auth: None,
            insecure: true,
        })
        .await
        .err()
        .unwrap();
        assert!(
            matches!(
                error,
                BundleError::Registry(RegistryError::DigestMismatch { .. })
            ),
            "{error:?}"
        );
    }
}
