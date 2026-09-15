//! Where things live: in the bundle image, and once injected into a sandbox.
//!
//! The bundle image (`deploy/bundle/Dockerfile`) builds exactly this tree under
//! [`BUNDLE_ROOT`]; `install` copies it under [`INJECTION_ROOT`]. Everything
//! the agent executes is referenced by absolute path under the injection root,
//! so the image's own `PATH` can stay first (see [`crate::env`]).

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// The bundle tree inside the bundle image.
pub const BUNDLE_ROOT: &str = "/opt/cognia";
/// The shared volume the bundle is staged into and the user image mounts.
pub const INJECTION_ROOT: &str = "/cognia";
/// Where the sandbox workspace is mounted (ADR-0183, `SANDBOX_WORKSPACE_FOLDER`).
pub const WORKSPACE_ROOT: &str = "/workspace";

pub const MANIFEST_FILE: &str = "bundle-manifest.json";
pub const PROBE_FILE: &str = "probe.json";
/// Static tools every image gets: `cognia-sandboxd`, `git`, `rg`.
pub const BIN_DIR: &str = "bin";
/// Static vendor binaries that run on either libc.
pub const COMMON_DIR: &str = "common";
/// `ca-bundle.pem`, for images that ship no CA store.
pub const CERTS_DIR: &str = "certs";
pub const CA_BUNDLE_FILE: &str = "certs/ca-bundle.pem";

/// Names `init-agent` reads from its own environment and never passes on.
pub const SANDBOXD_ENV_PREFIX: &str = "COGNIA_SANDBOXD_";
/// Comma-separated names the driver set explicitly for the agent. An ambient
/// credential variable not listed here came from the image, not from Cognia,
/// and is removed (see [`crate::env::AMBIENT_CREDENTIAL_ENV`]).
pub const PROVIDED_ENV_VAR: &str = "COGNIA_SANDBOXD_PROVIDED_ENV";

/// The C library an image's userland is built against. Not an OCI platform
/// dimension, which is why one bundle carries a tree for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Libc {
    Glibc,
    Musl,
}

impl Libc {
    pub const ALL: [Libc; 2] = [Libc::Glibc, Libc::Musl];

    pub fn as_str(self) -> &'static str {
        match self {
            Libc::Glibc => "glibc",
            Libc::Musl => "musl",
        }
    }
}

impl fmt::Display for Libc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Libc {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "glibc" => Ok(Libc::Glibc),
            "musl" => Ok(Libc::Musl),
            other => Err(format!("unknown libc {other:?}; expected glibc or musl")),
        }
    }
}

/// CPU architectures a bundle is published for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    Amd64,
    Arm64,
}

impl Arch {
    /// The architecture this binary was built for, `None` on one no bundle ships.
    pub fn current() -> Option<Arch> {
        match std::env::consts::ARCH {
            "x86_64" => Some(Arch::Amd64),
            "aarch64" => Some(Arch::Arm64),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Arch::Amd64 => "amd64",
            Arch::Arm64 => "arm64",
        }
    }

    /// `e_machine` of an ELF built for this architecture.
    pub fn elf_machine(self) -> u16 {
        match self {
            Arch::Amd64 => 62,  // EM_X86_64
            Arch::Arm64 => 183, // EM_AARCH64
        }
    }

    /// Dynamic loader file names, as they appear in `PT_INTERP`.
    pub fn loader_names(self, libc: Libc) -> &'static [&'static str] {
        match (self, libc) {
            (Arch::Amd64, Libc::Glibc) => &["ld-linux-x86-64.so.2"],
            (Arch::Arm64, Libc::Glibc) => &["ld-linux-aarch64.so.1"],
            (Arch::Amd64, Libc::Musl) => &["ld-musl-x86_64.so.1"],
            (Arch::Arm64, Libc::Musl) => &["ld-musl-aarch64.so.1"],
        }
    }

    /// Directories a distribution may keep its glibc in, most specific first.
    pub fn glibc_dirs(self) -> &'static [&'static str] {
        match self {
            Arch::Amd64 => &[
                "lib/x86_64-linux-gnu",
                "usr/lib/x86_64-linux-gnu",
                "lib64",
                "usr/lib64",
                "lib",
                "usr/lib",
            ],
            Arch::Arm64 => &[
                "lib/aarch64-linux-gnu",
                "usr/lib/aarch64-linux-gnu",
                "lib64",
                "usr/lib64",
                "lib",
                "usr/lib",
            ],
        }
    }
}

impl fmt::Display for Arch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The injected tree as the user image sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedLayout {
    pub root: PathBuf,
}

impl Default for InjectedLayout {
    fn default() -> Self {
        Self::at(INJECTION_ROOT)
    }
}

impl InjectedLayout {
    pub fn at(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    pub fn manifest(&self) -> PathBuf {
        self.root.join(MANIFEST_FILE)
    }

    pub fn probe(&self) -> PathBuf {
        self.root.join(PROBE_FILE)
    }

    pub fn ca_bundle(&self) -> PathBuf {
        self.root.join(CA_BUNDLE_FILE)
    }

    /// Directories appended to the agent's `PATH`, in lookup order.
    pub fn path_dirs(&self, libc: Option<Libc>) -> Vec<PathBuf> {
        let mut dirs = vec![self.root.join(BIN_DIR)];
        if let Some(libc) = libc {
            dirs.push(self.root.join(libc.as_str()).join(BIN_DIR));
        }
        dirs.push(self.root.join(COMMON_DIR).join(BIN_DIR));
        dirs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn libc_round_trips_through_text_and_json() {
        for libc in Libc::ALL {
            assert_eq!(libc.as_str().parse::<Libc>().unwrap(), libc);
            assert_eq!(
                serde_json::to_string(&libc).unwrap(),
                format!("\"{}\"", libc.as_str())
            );
        }
        assert!("uclibc".parse::<Libc>().is_err());
    }

    #[test]
    fn loader_names_are_per_arch_and_libc() {
        assert_eq!(
            Arch::Amd64.loader_names(Libc::Musl),
            &["ld-musl-x86_64.so.1"]
        );
        assert_eq!(
            Arch::Arm64.loader_names(Libc::Glibc),
            &["ld-linux-aarch64.so.1"]
        );
        assert_eq!(Arch::Amd64.elf_machine(), 62);
        assert_eq!(Arch::Arm64.elf_machine(), 183);
    }

    #[test]
    fn injected_path_dirs_put_static_tools_first_and_libc_tree_when_known() {
        let layout = InjectedLayout::default();
        assert_eq!(
            layout.path_dirs(Some(Libc::Musl)),
            vec![
                PathBuf::from("/cognia/bin"),
                PathBuf::from("/cognia/musl/bin"),
                PathBuf::from("/cognia/common/bin"),
            ]
        );
        assert_eq!(layout.path_dirs(None).len(), 2);
        assert_eq!(layout.probe(), PathBuf::from("/cognia/probe.json"));
    }
}
