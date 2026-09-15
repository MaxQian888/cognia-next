//! `probe`: can this image host the bundled agents, and as whom? (ADR-0183)
//!
//! Runs inside the user image, after the core bundle stage and before the libc
//! tree is chosen. It only reads: the image's `/bin/sh`, its loader and libc,
//! its passwd database and the mounted workspace. The report goes to
//! `probe.json`; the first problem decides the exit code the driver maps to a
//! refusal reason.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::elf::{self, ElfError};
use crate::layout::{Arch, Libc};
use crate::manifest::{BundleManifest, GlibcVersion, DEFAULT_MIN_GLIBC};
use crate::passwd::{self, ResolvedUser, UserError, UserSpec};
use crate::rootfs;

pub const PROBE_REPORT_VERSION: u32 = 1;

/// CA stores distributions ship, most common first.
const CA_BUNDLE_CANDIDATES: [&str; 5] = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/ssl/cert.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
];

/// A glibc `libc.so.6` is ~2 MiB; anything far larger is not one.
const MAX_LIBC_READ: u64 = 32 * 1024 * 1024;

/// Why an image cannot host the agent. The exit code is the contract with the
/// drivers (ADR-0183 table); the string is what the UI localizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProbeCode {
    /// `/bin/sh` was built for another architecture (an emulated image).
    #[serde(rename = "bundle_arch_mismatch")]
    ArchMismatch,
    #[serde(rename = "probe_libc_unsupported")]
    LibcUnsupported,
    #[serde(rename = "probe_glibc_too_old")]
    GlibcTooOld,
    #[serde(rename = "probe_no_shell")]
    NoShell,
    #[serde(rename = "probe_user_missing")]
    UserMissing,
    #[serde(rename = "probe_workspace_not_writable")]
    WorkspaceNotWritable,
}

impl ProbeCode {
    pub fn exit_code(self) -> i32 {
        match self {
            // The same code the container runtime reports when the probe
            // binary itself cannot exec, so drivers map one number.
            ProbeCode::ArchMismatch => 126,
            ProbeCode::LibcUnsupported => 64,
            ProbeCode::GlibcTooOld => 65,
            ProbeCode::NoShell => 66,
            ProbeCode::UserMissing => 67,
            ProbeCode::WorkspaceNotWritable => 68,
        }
    }

    /// The code a probe exit status stands for, for drivers reading it back.
    pub fn from_exit_code(code: i32) -> Option<ProbeCode> {
        [
            ProbeCode::ArchMismatch,
            ProbeCode::LibcUnsupported,
            ProbeCode::GlibcTooOld,
            ProbeCode::NoShell,
            ProbeCode::UserMissing,
            ProbeCode::WorkspaceNotWritable,
        ]
        .into_iter()
        .find(|candidate| candidate.exit_code() == code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeProblem {
    pub code: ProbeCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub version: u32,
    /// The architecture the probe ran as — the node's.
    pub arch: Arch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub libc: Option<Libc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glibc_version: Option<GlibcVersion>,
    /// `PT_INTERP` of `/bin/sh`, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interpreter: Option<String>,
    /// What `/bin/sh` resolves to inside the image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// The user the agent will run as; absent when that user does not exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<ResolvedUser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_writable: Option<bool>,
    pub workspace_writable: bool,
    /// The image's CA store, absent when it has none (the bundle's is used).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_bundle: Option<String>,
    /// Runtime ids from the bundle manifest this image's libc can run.
    pub runtimes: Vec<String>,
    pub problems: Vec<ProbeProblem>,
}

impl ProbeReport {
    /// 0 when the image can host the agent, otherwise the first problem's code.
    pub fn exit_code(&self) -> i32 {
        self.problems
            .first()
            .map(|problem| problem.code.exit_code())
            .unwrap_or(0)
    }
}

pub struct ProbeOptions<'a> {
    /// The image's root: `/` inside the container, a fixture in tests.
    pub root: &'a Path,
    pub arch: Arch,
    /// In-image path of the workspace mount.
    pub workspace: &'a str,
    /// Absent: the user the probe itself runs as (uid 0 in an init container).
    pub user: Option<&'a UserSpec>,
    pub manifest: Option<&'a BundleManifest>,
    /// Who is probing, for deciding whether a real write test is meaningful.
    pub probing_uid: u32,
}

/// What `/bin/sh` says about the image: where it is, the loader it asks for,
/// and so the libc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellInspection {
    pub shell: Option<String>,
    pub interpreter: Option<String>,
    pub libc: Option<Libc>,
    /// Architecture and libc problems only, in discovery order.
    pub problems: Vec<ProbeProblem>,
}

pub fn inspect_shell(root: &Path, arch: Arch) -> ShellInspection {
    let mut problems = Vec::new();
    let shell_host = rootfs::resolve(root, "/bin/sh")
        .ok()
        .filter(|path| is_executable_file(path));
    let shell = shell_host
        .as_ref()
        .map(|path| rootfs::image_path(root, path));
    let sh_elf = shell_host
        .as_ref()
        .and_then(|path| elf::inspect_file(path).ok());

    let mut interpreter = None;
    let mut libc = None;
    match sh_elf {
        Some(Ok(info)) => {
            if info.machine != arch.elf_machine() {
                problems.push(ProbeProblem {
                    code: ProbeCode::ArchMismatch,
                    message: format!(
                        "/bin/sh is built for ELF machine {}, this node is {arch}",
                        info.machine
                    ),
                });
            }
            if let Some(path) = &info.interpreter {
                libc = libc_of_loader(root, arch, path);
                if libc.is_none() {
                    problems.push(ProbeProblem {
                        code: ProbeCode::LibcUnsupported,
                        message: format!("/bin/sh uses the unsupported loader {path}"),
                    });
                }
            }
            interpreter = info.interpreter;
        }
        Some(Err(ElfError::Not64Bit)) => problems.push(ProbeProblem {
            code: ProbeCode::LibcUnsupported,
            message: "/bin/sh is a 32-bit program".into(),
        }),
        // Static, not ELF, unreadable or absent: the loader files decide.
        Some(Err(_)) | None => {}
    }
    let libc_reported = problems
        .iter()
        .any(|problem| problem.code == ProbeCode::LibcUnsupported);
    if libc.is_none() && !libc_reported {
        libc = libc_from_loader_files(root, arch);
        if libc.is_none() {
            problems.push(ProbeProblem {
                code: ProbeCode::LibcUnsupported,
                message: "the image has neither a glibc nor a musl dynamic loader".into(),
            });
        }
    }
    ShellInspection {
        shell,
        interpreter,
        libc,
        problems,
    }
}

/// The image's CA store, as an in-image path.
pub fn find_ca_bundle(root: &Path) -> Option<String> {
    CA_BUNDLE_CANDIDATES
        .iter()
        .find(|candidate| {
            rootfs::resolve(root, candidate).is_ok_and(|path| {
                fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
            })
        })
        .map(|candidate| candidate.to_string())
}

pub fn probe(options: &ProbeOptions<'_>) -> ProbeReport {
    let root = options.root;
    let ShellInspection {
        shell,
        interpreter,
        libc,
        mut problems,
    } = inspect_shell(root, options.arch);

    let mut glibc_version = None;
    if libc == Some(Libc::Glibc) {
        let required = options
            .manifest
            .map(|manifest| manifest.min_glibc)
            .unwrap_or(DEFAULT_MIN_GLIBC);
        match find_glibc_version(root, options.arch, interpreter.as_deref()) {
            Some(found) => {
                glibc_version = Some(found);
                if found < required {
                    problems.push(ProbeProblem {
                        code: ProbeCode::GlibcTooOld,
                        message: format!("glibc {found} is older than the required {required}"),
                    });
                }
            }
            None => problems.push(ProbeProblem {
                code: ProbeCode::LibcUnsupported,
                message: "the glibc version could not be read from libc.so.6".into(),
            }),
        }
    }

    if shell.is_none() {
        problems.push(ProbeProblem {
            code: ProbeCode::NoShell,
            message: "the image has no executable /bin/sh".into(),
        });
    }

    let requested = options
        .user
        .cloned()
        .unwrap_or(UserSpec::Uid(options.probing_uid));
    let user = match passwd::resolve_user(root, &requested) {
        Ok(user) => Some(user),
        Err(UserError::Missing(name)) => {
            problems.push(ProbeProblem {
                code: ProbeCode::UserMissing,
                message: format!("user {name} does not exist in the image"),
            });
            None
        }
    };

    let (workspace_writable, workspace_reason) = match &user {
        Some(user) => writable_by(root, options.workspace, user, options.probing_uid),
        None => (false, "the user does not exist".to_string()),
    };
    if !workspace_writable && user.is_some() {
        problems.push(ProbeProblem {
            code: ProbeCode::WorkspaceNotWritable,
            message: format!("{} is not writable: {workspace_reason}", options.workspace),
        });
    }
    let home_writable = user.as_ref().and_then(|user| {
        user.home
            .as_deref()
            .map(|home| writable_by(root, home, user, options.probing_uid).0)
    });

    let ca_bundle = find_ca_bundle(root);

    let runtimes = match (options.manifest, libc) {
        (Some(manifest), Some(libc)) => manifest.runtimes_for(libc),
        _ => Vec::new(),
    };

    // Exit-code order is the table's: architecture, libc, glibc, shell, user,
    // workspace. Checks above push roughly in that order; sort to guarantee it.
    problems.sort_by_key(|problem| match problem.code {
        ProbeCode::ArchMismatch => 0,
        code => code.exit_code(),
    });

    ProbeReport {
        version: PROBE_REPORT_VERSION,
        arch: options.arch,
        libc,
        glibc_version,
        interpreter,
        shell,
        user,
        home_writable,
        workspace_writable,
        ca_bundle,
        runtimes,
        problems,
    }
}

/// The libc a loader path belongs to, following it inside the image: Alpine's
/// `libc6-compat` makes `ld-linux-x86-64.so.2` a link to the musl loader.
fn libc_of_loader(root: &Path, arch: Arch, loader: &str) -> Option<Libc> {
    let final_name = rootfs::resolve(root, loader)
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| loader.rsplit('/').next().unwrap_or(loader).to_string());
    let named = loader.rsplit('/').next().unwrap_or(loader);
    for candidate in [final_name.as_str(), named] {
        for libc in [Libc::Musl, Libc::Glibc] {
            if arch.loader_names(libc).contains(&candidate) {
                return Some(libc);
            }
        }
    }
    // glibc's loader is often a versioned file behind the canonical name
    // (`ld-2.17.so` on older distributions); the name asked for decides then.
    None
}

/// For a static `/bin/sh`: which loader the image ships.
fn libc_from_loader_files(root: &Path, arch: Arch) -> Option<Libc> {
    let musl = arch
        .loader_names(Libc::Musl)
        .iter()
        .any(|name| rootfs::exists(root, &format!("/lib/{name}")));
    let glibc_loader = arch.loader_names(Libc::Glibc).iter().find_map(|name| {
        ["/lib64", "/lib", "/usr/lib64", "/usr/lib"]
            .into_iter()
            .map(|dir| format!("{dir}/{name}"))
            .chain(arch.glibc_dirs().iter().map(|dir| format!("/{dir}/{name}")))
            .find(|path| rootfs::exists(root, path))
    });
    match (musl, glibc_loader) {
        (true, None) => Some(Libc::Musl),
        (false, Some(_)) => Some(Libc::Glibc),
        (true, Some(path)) => libc_of_loader(root, arch, &path),
        (false, None) => None,
    }
}

/// The glibc release under `root`, read from `libc.so.6` without running it.
fn find_glibc_version(root: &Path, arch: Arch, interpreter: Option<&str>) -> Option<GlibcVersion> {
    let mut dirs: Vec<String> = Vec::new();
    if let Some(loader) = interpreter {
        if let Ok(host) = rootfs::resolve(root, loader) {
            if let Some(parent) = host.parent() {
                dirs.push(rootfs::image_path(root, parent));
            }
        }
    }
    dirs.extend(arch.glibc_dirs().iter().map(|dir| format!("/{dir}")));

    for dir in dirs {
        let Ok(host) = rootfs::resolve(root, &format!("{dir}/libc.so.6")) else {
            continue;
        };
        let Ok(file) = fs::File::open(&host) else {
            continue;
        };
        let mut bytes = Vec::new();
        if file.take(MAX_LIBC_READ).read_to_end(&mut bytes).is_err() {
            continue;
        }
        if let Some(version) = glibc_version_in(&bytes) {
            return Some(version);
        }
    }
    None
}

/// The release banner (`… stable release version 2.36.`), else the newest
/// `GLIBC_2.x` symbol version the library defines.
pub fn glibc_version_in(bytes: &[u8]) -> Option<GlibcVersion> {
    const BANNER: &[u8] = b"release version ";
    if let Some(at) = find(bytes, BANNER) {
        if let Some(version) = leading_version(&bytes[at + BANNER.len()..]) {
            return Some(version);
        }
    }
    const SYMBOL: &[u8] = b"GLIBC_";
    let mut newest: Option<GlibcVersion> = None;
    let mut offset = 0;
    while let Some(at) = find(&bytes[offset..], SYMBOL) {
        let start = offset + at + SYMBOL.len();
        if let Some(version) = leading_version(&bytes[start..]) {
            newest = Some(newest.map_or(version, |current| current.max(version)));
        }
        offset = start;
    }
    newest
}

fn leading_version(bytes: &[u8]) -> Option<GlibcVersion> {
    let text: String = bytes
        .iter()
        .take(16)
        .take_while(|b| b.is_ascii_digit() || **b == b'.')
        .map(|b| *b as char)
        .collect();
    let text = text.trim_end_matches('.');
    // `2.36` or `2.2.5`; a symbol like `GLIBC_PRIVATE` yields nothing.
    let mut parts = text.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    (major == 2).then_some(GlibcVersion { major, minor })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Whether `user` can create files in the in-image directory `path`, and why
/// not when it cannot.
fn writable_by(root: &Path, path: &str, user: &ResolvedUser, probing_uid: u32) -> (bool, String) {
    let Ok(host) = rootfs::resolve(root, path) else {
        return (false, "it does not exist".into());
    };
    let Ok(metadata) = fs::metadata(&host) else {
        return (false, "it cannot be read".into());
    };
    if !metadata.is_dir() {
        return (false, "it is not a directory".into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = metadata.permissions().mode();
        // A directory needs write and search permission to create entries.
        let allowed = if user.uid == 0 {
            true
        } else if metadata.uid() == user.uid {
            mode & 0o300 == 0o300
        } else if user.groups.contains(&metadata.gid()) {
            mode & 0o030 == 0o030
        } else {
            mode & 0o003 == 0o003
        };
        if !allowed {
            return (
                false,
                format!(
                    "mode {:o} owned by {}:{} does not allow uid {}",
                    mode & 0o7777,
                    metadata.uid(),
                    metadata.gid(),
                    user.uid
                ),
            );
        }
    }

    // Permission bits say nothing about a read-only mount. A real write is
    // conclusive when the prober has at least the target user's rights: root
    // (an init container), or the target user itself.
    if probing_uid == 0 || probing_uid == user.uid {
        let marker = host.join(format!(".cognia-probe-{}", std::process::id()));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
        {
            Ok(_) => {
                let _ = fs::remove_file(&marker);
            }
            Err(error) => return (false, format!("a test write failed: {error}")),
        }
    }
    (true, String::new())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::{symlink, PermissionsExt};

    use super::*;
    use crate::elf::test_elf;

    const X86: u16 = 62;

    struct Image {
        dir: tempfile::TempDir,
    }

    impl Image {
        fn new() -> Self {
            let image = Image {
                dir: tempfile::tempdir().unwrap(),
            };
            image.dir("workspace");
            image.write(
                "etc/passwd",
                b"root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n",
            );
            image.dir("root");
            image.dir("home/node");
            image
        }

        fn root(&self) -> &Path {
            self.dir.path()
        }

        fn dir(&self, path: &str) {
            fs::create_dir_all(self.root().join(path)).unwrap();
        }

        fn write(&self, path: &str, bytes: &[u8]) {
            let host = self.root().join(path);
            fs::create_dir_all(host.parent().unwrap()).unwrap();
            fs::write(host, bytes).unwrap();
        }

        fn executable(&self, path: &str, bytes: &[u8]) {
            self.write(path, bytes);
            fs::set_permissions(self.root().join(path), fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn link(&self, target: &str, path: &str) {
            let host = self.root().join(path);
            fs::create_dir_all(host.parent().unwrap()).unwrap();
            symlink(target, host).unwrap();
        }

        /// Debian bookworm: dash as sh, glibc 2.36 under the multiarch dir.
        fn debian(glibc_banner: &str) -> Self {
            let image = Image::new();
            image.executable(
                "usr/bin/dash",
                &test_elf(X86, Some("/lib64/ld-linux-x86-64.so.2")),
            );
            image.link("/usr/bin/dash", "bin/sh");
            image.write("lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", b"ld");
            image.link(
                "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
                "lib64/ld-linux-x86-64.so.2",
            );
            let mut libc = b"\x7fELF...GLIBC_2.2.5\0GLIBC_2.17\0GLIBC_PRIVATE\0".to_vec();
            libc.extend(glibc_banner.as_bytes());
            image.write("lib/x86_64-linux-gnu/libc.so.6", &libc);
            image.write(
                "etc/ssl/certs/ca-certificates.crt",
                b"-----BEGIN CERTIFICATE-----",
            );
            image
        }

        /// Alpine: busybox as sh, linked against musl.
        fn alpine() -> Self {
            let image = Image::new();
            image.executable(
                "bin/busybox",
                &test_elf(X86, Some("/lib/ld-musl-x86_64.so.1")),
            );
            image.link("/bin/busybox", "bin/sh");
            image.write("lib/ld-musl-x86_64.so.1", b"ld");
            image
        }

        fn probe(&self, user: Option<&UserSpec>, manifest: Option<&BundleManifest>) -> ProbeReport {
            probe(&ProbeOptions {
                root: self.root(),
                arch: Arch::Amd64,
                workspace: "/workspace",
                user,
                manifest,
                probing_uid: current_uid(),
            })
        }
    }

    fn current_uid() -> u32 {
        // SAFETY: getuid has no preconditions and cannot fail.
        unsafe { libc::getuid() }
    }

    fn manifest() -> BundleManifest {
        BundleManifest::parse(
            br#"{"version":1,"releaseTag":"v1","minGlibc":"2.28","runtimes":[
                {"id":"claude-code","version":"2","libc":["glibc","musl"]},
                {"id":"gemini-cli","version":"1","libc":["glibc"]}]}"#,
        )
        .unwrap()
    }

    fn codes(report: &ProbeReport) -> Vec<ProbeCode> {
        report.problems.iter().map(|problem| problem.code).collect()
    }

    /// The fixture tree is owned by whoever runs the tests; probe as them.
    fn me() -> UserSpec {
        UserSpec::Uid(current_uid())
    }

    #[test]
    fn a_debian_image_hosts_every_glibc_runtime() {
        let image =
            Image::debian("GNU C Library (Debian GLIBC 2.36-9) stable release version 2.36.");
        let manifest = manifest();
        let report = image.probe(Some(&me()), Some(&manifest));

        assert_eq!(codes(&report), []);
        assert_eq!(report.exit_code(), 0);
        assert_eq!(report.libc, Some(Libc::Glibc));
        assert_eq!(report.glibc_version, Some("2.36".parse().unwrap()));
        assert_eq!(
            report.interpreter.as_deref(),
            Some("/lib64/ld-linux-x86-64.so.2")
        );
        assert_eq!(report.shell.as_deref(), Some("/usr/bin/dash"));
        assert!(report.workspace_writable);
        assert_eq!(
            report.ca_bundle.as_deref(),
            Some("/etc/ssl/certs/ca-certificates.crt")
        );
        assert_eq!(report.runtimes, ["claude-code", "gemini-cli"]);
    }

    #[test]
    fn an_alpine_image_is_musl_and_drops_glibc_only_runtimes() {
        let image = Image::alpine();
        let manifest = manifest();
        let report = image.probe(Some(&me()), Some(&manifest));
        assert_eq!(codes(&report), []);
        assert_eq!(report.libc, Some(Libc::Musl));
        assert_eq!(report.glibc_version, None);
        assert_eq!(report.ca_bundle, None);
        assert_eq!(report.runtimes, ["claude-code"]);
    }

    #[test]
    fn the_shell_interpreter_beats_stray_loader_files() {
        // Debian with the `musl` package: an ld-musl file beside glibc.
        let debian = Image::debian("stable release version 2.36.");
        debian.write("lib/ld-musl-x86_64.so.1", b"ld");
        assert_eq!(debian.probe(Some(&me()), None).libc, Some(Libc::Glibc));

        // Alpine with libc6-compat: ld-linux is a link to the musl loader.
        let alpine = Image::alpine();
        alpine.link("/lib/ld-musl-x86_64.so.1", "lib64/ld-linux-x86-64.so.2");
        alpine.executable(
            "bin/busybox-compat",
            &test_elf(X86, Some("/lib64/ld-linux-x86-64.so.2")),
        );
        fs::remove_file(alpine.root().join("bin/sh")).unwrap();
        alpine.link("/bin/busybox-compat", "bin/sh");
        assert_eq!(alpine.probe(Some(&me()), None).libc, Some(Libc::Musl));
    }

    #[test]
    fn a_static_shell_falls_back_to_the_loader_on_disk() {
        let image = Image::new();
        image.executable("bin/sh", &test_elf(X86, None));
        image.write("lib/ld-musl-x86_64.so.1", b"ld");
        let report = image.probe(Some(&me()), None);
        assert_eq!(report.libc, Some(Libc::Musl));
        assert_eq!(report.interpreter, None);
    }

    #[test]
    fn refuses_old_glibc_with_the_manifest_minimum() {
        // CentOS 7: glibc 2.17, no banner match beyond symbol versions.
        let image = Image::debian("");
        let manifest = manifest();
        let report = image.probe(Some(&me()), Some(&manifest));
        assert_eq!(codes(&report), [ProbeCode::GlibcTooOld]);
        assert_eq!(report.exit_code(), 65);
        assert_eq!(report.glibc_version, Some("2.17".parse().unwrap()));
    }

    #[test]
    fn refuses_an_unknown_loader_and_an_unreadable_glibc() {
        let uclibc = Image::new();
        uclibc.executable("bin/sh", &test_elf(X86, Some("/lib/ld-uClibc.so.0")));
        let report = uclibc.probe(Some(&me()), None);
        assert_eq!(codes(&report), [ProbeCode::LibcUnsupported]);
        assert_eq!(report.exit_code(), 64);

        let stripped = Image::debian("");
        stripped.write("lib/x86_64-linux-gnu/libc.so.6", b"no version strings here");
        assert_eq!(
            codes(&stripped.probe(Some(&me()), None)),
            [ProbeCode::LibcUnsupported]
        );
    }

    #[test]
    fn reports_a_foreign_architecture_first() {
        let image = Image::new();
        image.executable("bin/sh", &test_elf(183, Some("/lib/ld-linux-aarch64.so.1")));
        let report = image.probe(Some(&UserSpec::Name("ghost".into())), None);
        assert_eq!(
            codes(&report),
            [
                ProbeCode::ArchMismatch,
                ProbeCode::LibcUnsupported,
                ProbeCode::UserMissing
            ]
        );
        assert_eq!(report.exit_code(), 126);
    }

    #[test]
    fn refuses_an_image_without_a_shell() {
        let image = Image::new();
        image.write("lib/ld-musl-x86_64.so.1", b"ld");
        let report = image.probe(Some(&me()), None);
        assert_eq!(codes(&report), [ProbeCode::NoShell]);
        assert_eq!(report.shell, None);

        // A shell that is not executable counts as none.
        image.write("bin/sh", &test_elf(X86, Some("/lib/ld-musl-x86_64.so.1")));
        assert_eq!(codes(&image.probe(Some(&me()), None)), [ProbeCode::NoShell]);
    }

    #[test]
    fn refuses_a_missing_named_user_but_not_a_bare_uid() {
        let image = Image::alpine();
        let report = image.probe(Some(&UserSpec::Name("vscode".into())), None);
        assert_eq!(codes(&report), [ProbeCode::UserMissing]);
        assert_eq!(report.user, None);
        assert!(!report.workspace_writable);
        assert_eq!(report.exit_code(), 67);

        let uid = image.probe(Some(&me()), None);
        assert_eq!(uid.user.as_ref().map(|user| user.uid), Some(current_uid()));
    }

    #[test]
    fn checks_the_workspace_for_the_target_user() {
        let image = Image::alpine();
        fs::set_permissions(
            image.root().join("workspace"),
            fs::Permissions::from_mode(0o555),
        )
        .unwrap();
        let report = image.probe(Some(&me()), None);
        if current_uid() != 0 {
            assert_eq!(codes(&report), [ProbeCode::WorkspaceNotWritable]);
            assert_eq!(report.exit_code(), 68);
        }
        fs::set_permissions(
            image.root().join("workspace"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        // Someone else's 0755 directory is not writable for a non-root uid.
        let other = UserSpec::Uid(current_uid().wrapping_add(4242));
        assert_eq!(
            codes(&image.probe(Some(&other), None)),
            [ProbeCode::WorkspaceNotWritable]
        );

        fs::remove_dir(image.root().join("workspace")).unwrap();
        let missing = image.probe(Some(&me()), None);
        assert_eq!(codes(&missing), [ProbeCode::WorkspaceNotWritable]);
        assert!(missing.problems[0].message.contains("does not exist"));
    }

    #[test]
    fn reads_glibc_versions_from_banners_and_symbols() {
        assert_eq!(
            glibc_version_in(b"GNU C Library (GNU libc) stable release version 2.17, by Roland"),
            Some("2.17".parse().unwrap())
        );
        assert_eq!(
            glibc_version_in(b"xx development release version 2.39.9000.\0"),
            Some("2.39".parse().unwrap())
        );
        assert_eq!(
            glibc_version_in(b"GLIBC_2.2.5\0GLIBC_2.34\0GLIBC_2.4\0GLIBC_PRIVATE"),
            Some("2.34".parse().unwrap())
        );
        assert_eq!(glibc_version_in(b"musl libc"), None);
    }

    #[test]
    fn exit_codes_round_trip_and_serialize_as_reason_codes() {
        for code in [
            ProbeCode::ArchMismatch,
            ProbeCode::LibcUnsupported,
            ProbeCode::GlibcTooOld,
            ProbeCode::NoShell,
            ProbeCode::UserMissing,
            ProbeCode::WorkspaceNotWritable,
        ] {
            assert_eq!(ProbeCode::from_exit_code(code.exit_code()), Some(code));
        }
        assert_eq!(ProbeCode::from_exit_code(1), None);
        assert_eq!(
            serde_json::to_value(ProbeCode::GlibcTooOld).unwrap(),
            "probe_glibc_too_old"
        );

        let report = Image::alpine().probe(Some(&me()), None);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["libc"], "musl");
        assert_eq!(json["workspaceWritable"], true);
        assert!(json.get("glibcVersion").is_none());
        let back: ProbeReport = serde_json::from_value(json).unwrap();
        assert_eq!(back, report);
    }
}
