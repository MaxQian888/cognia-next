//! The always-on server host's own service (ADR-0224 A1).
//!
//! A host install is a directory with a fixed layout (see [`HostLayout`]): the
//! `cognia-server` front door, the brain, its sidecars and a pinned Node.
//! Installing the service copies it into the data dir's install home
//! (`install/versions/<version>`, with `install/current` pointing at it; see
//! [`crate::install_home`]) and runs `cognia-server serve` through `current`, so
//! the host can later swap in a new version itself (ADR-0224 A10). The master
//! key lives in a 0600 file the service account owns, or, for a Linux system
//! service, in a root-only file handed over as a systemd credential.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::install_home::InstallHome;
use crate::{RestartPolicy, ServicePlatform, ServiceScope, ServiceSpec};

/// launchd label of the server host.
pub const SERVER_LABEL: &str = "com.cognia.server";
/// systemd unit stem of the server host.
pub const SERVER_UNIT: &str = "cognia-server";
/// Master key file name inside a data dir (or `/etc/cognia-server`).
pub const MASTER_KEY_FILE_NAME: &str = "master.key";
/// systemd credential name the secret store reads from `$CREDENTIALS_DIRECTORY`.
/// Must match `cognia_secrets::secret_store::MASTER_KEY_CREDENTIAL`.
pub const MASTER_KEY_CREDENTIAL: &str = "cognia-master-key";
/// Where a Linux system service keeps its root-only master key.
pub const LINUX_SYSTEM_KEY_DIR: &str = "/etc/cognia-server";

/// The fixed layout of a host install directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLayout {
    pub root: PathBuf,
}

impl HostLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The install a `cognia-server` binary at `<root>/bin/cognia-server` belongs to.
    pub fn from_server_binary(binary: &Path) -> Option<Self> {
        let bin = binary.parent()?;
        if bin.file_name()? != "bin" {
            return None;
        }
        Some(Self::new(bin.parent()?))
    }

    pub fn server_binary(&self) -> PathBuf {
        self.root.join("bin").join("cognia-server")
    }

    pub fn node_bin_dir(&self) -> PathBuf {
        self.root.join("node").join("bin")
    }

    pub fn node(&self) -> PathBuf {
        self.node_bin_dir().join("node")
    }

    pub fn brain_entry(&self) -> PathBuf {
        self.root.join("brain").join("cli.mjs")
    }

    pub fn sidecar_script(&self) -> PathBuf {
        self.root.join("brain").join("sidecar").join("claude-host.mjs")
    }

    /// Every file the service needs that is not there.
    pub fn missing(&self, exists: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
        [
            self.server_binary(),
            self.node(),
            self.brain_entry(),
            self.sidecar_script(),
        ]
        .into_iter()
        .filter(|path| !exists(path))
        .collect()
    }
}

/// Where the master key lives for an install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MasterKeyPlacement {
    /// A file the service account can read, passed as `COGNIA_MASTER_KEY_FILE`.
    File(PathBuf),
    /// A root-only file systemd reads and hands over as a credential.
    SystemdCredential(PathBuf),
}

impl MasterKeyPlacement {
    pub fn path(&self) -> &Path {
        match self {
            MasterKeyPlacement::File(path) | MasterKeyPlacement::SystemdCredential(path) => path,
        }
    }

    /// The default for a platform and scope: a root-only credential for a Linux
    /// system service, otherwise a file in the data dir.
    pub fn default_for(platform: ServicePlatform, scope: ServiceScope, data_dir: &Path) -> Self {
        match (platform, scope) {
            (ServicePlatform::Linux, ServiceScope::System) => MasterKeyPlacement::SystemdCredential(
                PathBuf::from(LINUX_SYSTEM_KEY_DIR).join(MASTER_KEY_FILE_NAME),
            ),
            _ => MasterKeyPlacement::File(data_dir.join(MASTER_KEY_FILE_NAME)),
        }
    }
}

/// Everything that varies between server host installs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerServiceOptions {
    /// The layout the service runs: its install home's `current`.
    pub layout: HostLayout,
    pub data_dir: PathBuf,
    pub port: u16,
    pub public_url: Option<String>,
    /// Account a system-scope service runs as.
    pub run_as: Option<String>,
    /// Home of the account the service runs as (launchd does not set `HOME`
    /// for a daemon).
    pub home: Option<PathBuf>,
    pub master_key: MasterKeyPlacement,
    /// Advertise over mDNS. Off for hosts on shared networks.
    pub mdns: bool,
    /// Local account the host serves (`COGNIA_LOCAL_ACCOUNT_ID`); `None` keeps
    /// the server's own default.
    pub local_account_id: Option<String>,
}

/// The search path a service gets: the bundled Node first, then the system's.
fn service_path(layout: &HostLayout, platform: ServicePlatform) -> String {
    let mut entries = vec![layout.node_bin_dir().to_string_lossy().into_owned()];
    if platform == ServicePlatform::MacOs {
        // Docker Desktop and Homebrew install their CLIs here; the sandbox pool
        // shells out to neither, but agents running on the host do.
        entries.push("/opt/homebrew/bin".into());
    }
    entries.extend(
        ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from),
    );
    entries.join(":")
}

/// The service definition for a server host install.
pub fn server_service_spec(opts: &ServerServiceOptions, platform: ServicePlatform) -> ServiceSpec {
    let mut env = BTreeMap::from([
        (
            "COGNIA_DATA_DIR".to_string(),
            opts.data_dir.to_string_lossy().into_owned(),
        ),
        (
            "COGNIA_BRAIN_ENTRY".to_string(),
            opts.layout.brain_entry().to_string_lossy().into_owned(),
        ),
        (
            "COGNIA_SIDECAR_SCRIPT".to_string(),
            opts.layout.sidecar_script().to_string_lossy().into_owned(),
        ),
        ("NODE_ENV".to_string(), "production".to_string()),
        ("PATH".to_string(), service_path(&opts.layout, platform)),
        // The service manager starts it again after an update swaps
        // `current`; without one, the host does not update itself.
        ("COGNIA_SERVICE_MANAGED".to_string(), "1".to_string()),
    ]);
    if let Some(url) = &opts.public_url {
        env.insert("COGNIA_PUBLIC_URL".to_string(), url.clone());
    }
    if let Some(home) = &opts.home {
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
    }
    if let Some(account) = &opts.local_account_id {
        env.insert("COGNIA_LOCAL_ACCOUNT_ID".to_string(), account.clone());
    }
    let mut credentials = Vec::new();
    match &opts.master_key {
        MasterKeyPlacement::File(path) => {
            env.insert(
                "COGNIA_MASTER_KEY_FILE".to_string(),
                path.to_string_lossy().into_owned(),
            );
        }
        MasterKeyPlacement::SystemdCredential(path) => {
            credentials.push((MASTER_KEY_CREDENTIAL.to_string(), path.clone()));
        }
    }
    let mut args = vec!["serve".to_string(), "--port".to_string(), opts.port.to_string()];
    if !opts.mdns {
        args.push("--no-mdns".to_string());
    }
    ServiceSpec {
        label: SERVER_LABEL.to_string(),
        unit: SERVER_UNIT.to_string(),
        description: "Cognia always-on host".to_string(),
        program: opts.layout.server_binary(),
        args,
        env,
        working_directory: Some(opts.data_dir.clone()),
        log_path: Some(opts.data_dir.join("logs").join("cognia-server.log")),
        run_as: opts.run_as.clone(),
        credentials,
        restart: RestartPolicy::Always,
    }
}

/// An OS account, for running a system service as someone other than root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRecord {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: PathBuf,
}

/// Look an account up by name.
#[cfg(unix)]
pub fn lookup_account(name: &str) -> Option<AccountRecord> {
    use std::ffi::{CStr, CString};
    let c_name = CString::new(name).ok()?;
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the duration of the call and the buffer
    // length matches its allocation; `getpwnam_r` writes only into them.
    let code = unsafe {
        libc::getpwnam_r(
            c_name.as_ptr(),
            &mut record,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        )
    };
    if code != 0 || result.is_null() {
        return None;
    }
    // SAFETY: on success `pw_dir` points into `buffer`, NUL-terminated.
    let home = unsafe { CStr::from_ptr(record.pw_dir) }
        .to_string_lossy()
        .into_owned();
    Some(AccountRecord {
        name: name.to_string(),
        uid: record.pw_uid,
        gid: record.pw_gid,
        home: PathBuf::from(home),
    })
}

#[cfg(not(unix))]
pub fn lookup_account(_name: &str) -> Option<AccountRecord> {
    None
}

/// The default data dir of a server host run by `home`'s owner: the same
/// directory `cognia-server` picks when that user runs it by hand, so `pair`
/// and `devices` find the service's state without flags.
pub fn default_data_dir(platform: ServicePlatform, home: &Path) -> PathBuf {
    match platform {
        ServicePlatform::MacOs => home.join("Library/Application Support/cognia-server"),
        ServicePlatform::Linux => home.join(".local/share/cognia-server"),
    }
}

/// Whether `raw` is a master key (64 hex characters, surrounding whitespace allowed).
pub fn is_master_key(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What [`ensure_master_key_file`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterKeyFile {
    Created,
    /// A valid key was already there; it is never replaced.
    Existing,
}

/// Create a master key file (0600, 32 random bytes as hex) unless one exists.
///
/// An existing file is validated and left alone: replacing a master key makes
/// every secret sealed under it unreadable. `owner` hands the file to the
/// service account when root is installing for someone else.
pub fn ensure_master_key_file(
    path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<MasterKeyFile, String> {
    if path.exists() {
        let raw = std::fs::read_to_string(path)
            .map_err(|error| format!("read master key {}: {error}", path.display()))?;
        if !is_master_key(&raw) {
            return Err(format!(
                "{} exists but is not a 64-hex master key; it was left untouched",
                path.display()
            ));
        }
        return Ok(MasterKeyFile::Existing);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let mut key = [0u8; 32];
    rand::fill(&mut key);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("create master key {}: {error}", path.display()))?;
    file.write_all(format!("{}\n", hex::encode(key)).as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("write master key {}: {error}", path.display()))?;
    if let Some((uid, gid)) = owner {
        chown(path, uid, gid)?;
    }
    Ok(MasterKeyFile::Created)
}

/// Hand `path` to `uid:gid`.
#[cfg(unix)]
pub fn chown(path: &Path, uid: u32, gid: u32) -> Result<(), String> {
    std::os::unix::fs::chown(path, Some(uid), Some(gid))
        .map_err(|error| format!("chown {}: {error}", path.display()))
}

#[cfg(not(unix))]
pub fn chown(_path: &Path, _uid: u32, _gid: u32) -> Result<(), String> {
    Ok(())
}

/// Hand a whole tree to `uid:gid`, links included, without following them.
#[cfg(unix)]
pub fn chown_tree(root: &Path, uid: u32, gid: u32) -> Result<(), String> {
    std::os::unix::fs::lchown(root, Some(uid), Some(gid))
        .map_err(|error| format!("chown {}: {error}", root.display()))?;
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("stat {}: {error}", root.display()))?;
    if metadata.is_dir() {
        let entries =
            std::fs::read_dir(root).map_err(|error| format!("read {}: {error}", root.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("read {}: {error}", root.display()))?;
            chown_tree(&entry.path(), uid, gid)?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn chown_tree(_root: &Path, _uid: u32, _gid: u32) -> Result<(), String> {
    Ok(())
}

/// The ancestors of `dir` strictly below `home` that do not exist yet, i.e.
/// the parents `create_dir_all(dir)` will create inside that home.
fn missing_dirs_below(dir: &Path, home: &Path, exists: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    dir.ancestors()
        .skip(1)
        .take_while(|parent| parent.starts_with(home) && *parent != home)
        .filter(|parent| !exists(parent))
        .map(Path::to_path_buf)
        .collect()
}

/// What `cognia-server service install` was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallRequest {
    pub scope: ServiceScope,
    /// Install directory; defaults to the one the running binary belongs to.
    pub install_root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub port: u16,
    pub public_url: Option<String>,
    /// Account a system service runs as; defaults to `SUDO_USER`.
    pub run_as: Option<String>,
    pub mdns: bool,
    pub local_account_id: Option<String>,
}

/// What an install did, for the operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallReport {
    pub definition_path: PathBuf,
    pub data_dir: PathBuf,
    pub master_key: PathBuf,
    pub master_key_created: bool,
    /// The key is a root-only systemd credential: the service account cannot
    /// read it, so a command it runs by hand must be handed the key.
    pub master_key_root_only: bool,
    /// The installed `cognia-server`, which need not be on `PATH`.
    pub server_binary: PathBuf,
    /// The release the install home now runs.
    pub installed_version: String,
    pub run_as: Option<String>,
    pub notes: Vec<String>,
}

/// The facts an install depends on, injected so the decision logic is testable.
pub struct InstallEnvironment<'a> {
    pub platform: ServicePlatform,
    pub ctx: &'a crate::InstallerContext,
    pub is_root: bool,
    pub current_exe: Option<PathBuf>,
    pub sudo_user: Option<String>,
    pub exists: &'a dyn Fn(&Path) -> bool,
    pub lookup: &'a dyn Fn(&str) -> Option<AccountRecord>,
}

impl InstallEnvironment<'_> {
    /// The environment of this process.
    pub fn current<'a>(
        ctx: &'a crate::InstallerContext,
        exists: &'a dyn Fn(&Path) -> bool,
        lookup: &'a dyn Fn(&str) -> Option<AccountRecord>,
    ) -> Result<InstallEnvironment<'a>, crate::ServiceError> {
        Ok(InstallEnvironment {
            platform: ServicePlatform::current()?,
            ctx,
            is_root: crate::running_as_root(),
            current_exe: std::env::current_exe().ok(),
            sudo_user: std::env::var("SUDO_USER").ok().filter(|name| !name.is_empty()),
            exists,
            lookup,
        })
    }
}

/// A fully resolved install, before anything is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInstall {
    /// The install directory being installed (an unpacked archive).
    pub source: HostLayout,
    /// Where it is copied to and run from.
    pub home: InstallHome,
    pub options: ServerServiceOptions,
    pub spec: ServiceSpec,
    /// Owner of the data dir and a file master key in the system scope.
    pub owner: Option<(u32, u32)>,
}

/// Decide everything an install will do, refusing what it must not do.
pub fn resolve_install(
    request: &InstallRequest,
    env: &InstallEnvironment<'_>,
) -> Result<ResolvedInstall, crate::ServiceError> {
    use crate::ServiceError;
    let layout = match &request.install_root {
        Some(root) => HostLayout::new(root),
        None => env
            .current_exe
            .as_deref()
            .and_then(HostLayout::from_server_binary)
            .ok_or_else(|| {
                ServiceError::Invalid(
                    "this cognia-server is not inside a host install (`<root>/bin/cognia-server`); \
                     pass --install-root, or install the host archive first"
                        .into(),
                )
            })?,
    };
    let missing = layout.missing(env.exists);
    if !missing.is_empty() {
        let list = missing
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(ServiceError::Invalid(format!(
            "{} is not a complete host install; missing: {list}",
            layout.root.display()
        )));
    }
    let (account, owner) = match request.scope {
        ServiceScope::System => {
            if !env.is_root {
                return Err(ServiceError::NotRoot);
            }
            let name = request
                .run_as
                .clone()
                .or_else(|| env.sudo_user.clone())
                .ok_or(ServiceError::SystemScopeWithoutUser)?;
            if name == "root" {
                return Err(ServiceError::Invalid(
                    "the host must not run as root; pass --run-as <account>".into(),
                ));
            }
            let record = (env.lookup)(&name).ok_or_else(|| {
                ServiceError::Invalid(format!("no such account: {name}"))
            })?;
            let owner = Some((record.uid, record.gid));
            (Some(record), owner)
        }
        ServiceScope::User => {
            // Under sudo, root's launchd domain or user manager would take the
            // service, and the data dir and key would be created root-owned.
            if env.is_root {
                return Err(ServiceError::Invalid(
                    "a user-scope service is installed by its own user; rerun without sudo, \
                     or choose --scope system"
                        .into(),
                ));
            }
            (None, None)
        }
    };
    let home = account
        .as_ref()
        .map(|record| record.home.clone())
        .unwrap_or_else(|| env.ctx.home.clone());
    let data_dir = request
        .data_dir
        .clone()
        .unwrap_or_else(|| default_data_dir(env.platform, &home));
    let install_home = InstallHome::in_data_dir(&data_dir);
    let options = ServerServiceOptions {
        master_key: MasterKeyPlacement::default_for(env.platform, request.scope, &data_dir),
        layout: install_home.current_layout(),
        data_dir,
        port: request.port,
        public_url: request.public_url.clone(),
        run_as: account.as_ref().map(|record| record.name.clone()),
        home: Some(home),
        mdns: request.mdns,
        local_account_id: request.local_account_id.clone(),
    };
    let spec = server_service_spec(&options, env.platform);
    Ok(ResolvedInstall {
        source: layout,
        home: install_home,
        options,
        spec,
        owner,
    })
}

/// Install the server host as a service: data dir, master key, definition.
pub fn install_server_service(
    request: &InstallRequest,
    env: &InstallEnvironment<'_>,
    io: &dyn crate::ServiceIo,
) -> Result<InstallReport, crate::ServiceError> {
    use crate::ServiceError;
    let resolved = resolve_install(request, env)?;
    let opts = &resolved.options;
    let logs = opts.data_dir.join("logs");
    // Parents created for a data dir in the service account's home (a fresh
    // `~/.local/share`) must be theirs too, not root's.
    let new_parents = match (resolved.owner, opts.home.as_deref()) {
        (Some(_), Some(home)) => missing_dirs_below(&opts.data_dir, home, &|dir| io.exists(dir)),
        _ => Vec::new(),
    };
    for dir in [&opts.data_dir, &logs] {
        io.create_dir_all(dir).map_err(|error| ServiceError::Io {
            action: format!("create {}", dir.display()),
            detail: error.to_string(),
        })?;
        if let Some((uid, gid)) = resolved.owner {
            chown(dir, uid, gid).map_err(ServiceError::Invalid)?;
        }
    }
    if let Some((uid, gid)) = resolved.owner {
        for dir in &new_parents {
            chown(dir, uid, gid).map_err(ServiceError::Invalid)?;
        }
    }
    let key_owner = match &opts.master_key {
        // systemd reads a credential as root; it stays root-only.
        MasterKeyPlacement::SystemdCredential(_) => None,
        MasterKeyPlacement::File(_) => resolved.owner,
    };
    let created = ensure_master_key_file(opts.master_key.path(), key_owner)
        .map_err(ServiceError::Invalid)?;
    let installed_version = resolved
        .home
        .adopt(&resolved.source.root)
        .map_err(|error| ServiceError::Invalid(error.to_string()))?;
    // The service account updates its own install later.
    if let Some((uid, gid)) = resolved.owner {
        chown_tree(resolved.home.root(), uid, gid).map_err(ServiceError::Invalid)?;
    }
    let plan = crate::install(&resolved.spec, request.scope, env.platform, env.ctx, io)?;
    Ok(InstallReport {
        definition_path: plan.definition_path,
        data_dir: opts.data_dir.clone(),
        master_key: opts.master_key.path().to_path_buf(),
        master_key_created: created == MasterKeyFile::Created,
        master_key_root_only: matches!(opts.master_key, MasterKeyPlacement::SystemdCredential(_)),
        server_binary: opts.layout.server_binary(),
        installed_version,
        run_as: opts.run_as.clone(),
        notes: plan.notes,
    })
}

/// The service identity `uninstall` and `status` act on: the server's label and
/// unit, independent of how it was installed.
pub fn server_service_identity() -> ServiceSpec {
    ServiceSpec {
        label: SERVER_LABEL.to_string(),
        unit: SERVER_UNIT.to_string(),
        description: "Cognia always-on host".to_string(),
        program: PathBuf::from("/"),
        args: Vec::new(),
        env: BTreeMap::new(),
        working_directory: None,
        log_path: None,
        run_as: None,
        credentials: Vec::new(),
        restart: RestartPolicy::Always,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(platform: ServicePlatform, scope: ServiceScope) -> ServerServiceOptions {
        let data_dir = PathBuf::from("/srv/cognia");
        ServerServiceOptions {
            layout: HostLayout::new("/opt/cognia"),
            master_key: MasterKeyPlacement::default_for(platform, scope, &data_dir),
            data_dir,
            port: 27890,
            public_url: Some("https://host.example".into()),
            run_as: Some("max".into()),
            home: Some(PathBuf::from("/home/max")),
            mdns: false,
            local_account_id: Some("local_acct_b".into()),
        }
    }

    #[test]
    fn layout_is_found_from_the_binary_and_reports_what_is_missing() {
        let layout = HostLayout::from_server_binary(Path::new("/opt/cognia/bin/cognia-server"))
            .expect("bin/ layout");
        assert_eq!(layout.root, PathBuf::from("/opt/cognia"));
        assert_eq!(layout.brain_entry(), PathBuf::from("/opt/cognia/brain/cli.mjs"));
        // The desktop bundle's copy lives in Contents/MacOS, which is not an install.
        assert!(HostLayout::from_server_binary(Path::new(
            "/Applications/Cognia.app/Contents/MacOS/cognia-server"
        ))
        .is_none());
        let missing = layout.missing(|path| path.ends_with("cognia-server"));
        assert_eq!(missing.len(), 3);
        assert!(missing.contains(&layout.node()));
    }

    #[test]
    fn the_service_runs_serve_from_the_install_against_the_data_dir() {
        let spec = server_service_spec(
            &options(ServicePlatform::MacOs, ServiceScope::System),
            ServicePlatform::MacOs,
        );
        assert_eq!(spec.label, SERVER_LABEL);
        assert_eq!(spec.program, PathBuf::from("/opt/cognia/bin/cognia-server"));
        assert_eq!(spec.args, vec!["serve", "--port", "27890", "--no-mdns"]);
        assert_eq!(spec.env["COGNIA_DATA_DIR"], "/srv/cognia");
        assert_eq!(spec.env["COGNIA_BRAIN_ENTRY"], "/opt/cognia/brain/cli.mjs");
        assert_eq!(
            spec.env["COGNIA_SIDECAR_SCRIPT"],
            "/opt/cognia/brain/sidecar/claude-host.mjs"
        );
        assert_eq!(spec.env["COGNIA_MASTER_KEY_FILE"], "/srv/cognia/master.key");
        assert_eq!(spec.env["COGNIA_PUBLIC_URL"], "https://host.example");
        assert_eq!(spec.env["HOME"], "/home/max");
        assert_eq!(spec.env["COGNIA_LOCAL_ACCOUNT_ID"], "local_acct_b");
        assert!(spec.env["PATH"].starts_with("/opt/cognia/node/bin:"));
        assert!(spec.credentials.is_empty());
        assert_eq!(spec.run_as.as_deref(), Some("max"));
    }

    #[test]
    fn a_linux_system_service_gets_its_key_as_a_root_only_credential() {
        let spec = server_service_spec(
            &options(ServicePlatform::Linux, ServiceScope::System),
            ServicePlatform::Linux,
        );
        assert!(!spec.env.contains_key("COGNIA_MASTER_KEY_FILE"));
        assert_eq!(
            spec.credentials,
            vec![(
                MASTER_KEY_CREDENTIAL.to_string(),
                PathBuf::from("/etc/cognia-server/master.key")
            )]
        );
        let user = MasterKeyPlacement::default_for(
            ServicePlatform::Linux,
            ServiceScope::User,
            Path::new("/d"),
        );
        assert_eq!(user, MasterKeyPlacement::File(PathBuf::from("/d/master.key")));
    }

    #[test]
    fn default_data_dir_matches_the_interactive_default() {
        assert_eq!(
            default_data_dir(ServicePlatform::MacOs, Path::new("/Users/max")),
            PathBuf::from("/Users/max/Library/Application Support/cognia-server")
        );
        assert_eq!(
            default_data_dir(ServicePlatform::Linux, Path::new("/home/max")),
            PathBuf::from("/home/max/.local/share/cognia-server")
        );
    }

    #[test]
    fn a_master_key_file_is_created_once_and_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(MASTER_KEY_FILE_NAME);
        assert_eq!(ensure_master_key_file(&path, None).unwrap(), MasterKeyFile::Created);
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(is_master_key(&first));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(ensure_master_key_file(&path, None).unwrap(), MasterKeyFile::Existing);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);

        let junk = dir.path().join("junk.key");
        std::fs::write(&junk, "not a key").unwrap();
        let error = ensure_master_key_file(&junk, None).unwrap_err();
        assert!(error.contains("left untouched"));
        assert_eq!(std::fs::read_to_string(&junk).unwrap(), "not a key");
    }

    fn installer_ctx() -> crate::InstallerContext {
        crate::InstallerContext {
            home: PathBuf::from("/Users/admin"),
            uid: 0,
        }
    }

    fn account(name: &str) -> Option<AccountRecord> {
        (name == "max").then(|| AccountRecord {
            name: "max".into(),
            uid: 501,
            gid: 20,
            home: PathBuf::from("/Users/max"),
        })
    }

    fn request(scope: ServiceScope) -> InstallRequest {
        InstallRequest {
            scope,
            install_root: None,
            data_dir: None,
            port: 27890,
            public_url: None,
            run_as: None,
            mdns: true,
            local_account_id: None,
        }
    }

    fn env<'a>(
        ctx: &'a crate::InstallerContext,
        exists: &'a dyn Fn(&Path) -> bool,
        lookup: &'a dyn Fn(&str) -> Option<AccountRecord>,
        is_root: bool,
    ) -> InstallEnvironment<'a> {
        InstallEnvironment {
            platform: ServicePlatform::MacOs,
            ctx,
            is_root,
            current_exe: Some(PathBuf::from("/opt/cognia/bin/cognia-server")),
            sudo_user: Some("max".into()),
            exists,
            lookup,
        }
    }

    #[test]
    fn a_system_install_runs_as_the_sudo_user_in_their_data_dir() {
        let ctx = installer_ctx();
        let everything = |_: &Path| true;
        let resolved =
            resolve_install(&request(ServiceScope::System), &env(&ctx, &everything, &account, true))
                .unwrap();
        assert_eq!(resolved.options.run_as.as_deref(), Some("max"));
        assert_eq!(resolved.owner, Some((501, 20)));
        assert_eq!(
            resolved.options.data_dir,
            PathBuf::from("/Users/max/Library/Application Support/cognia-server")
        );
        assert_eq!(resolved.spec.env["HOME"], "/Users/max");
        // The archive is copied into the data dir's install home and run
        // through `current`, so the host can swap versions itself.
        assert_eq!(resolved.source.root, PathBuf::from("/opt/cognia"));
        let data = PathBuf::from("/Users/max/Library/Application Support/cognia-server");
        assert_eq!(resolved.options.layout.root, data.join("install/current"));
        assert_eq!(
            resolved.spec.program,
            data.join("install/current/bin/cognia-server")
        );
        assert_eq!(resolved.spec.env["COGNIA_SERVICE_MANAGED"], "1");
    }

    #[test]
    fn an_install_refuses_what_it_must_not_do() {
        let ctx = installer_ctx();
        let everything = |_: &Path| true;
        let nothing = |_: &Path| false;
        let system = request(ServiceScope::System);

        assert_eq!(
            resolve_install(&system, &env(&ctx, &everything, &account, false)),
            Err(crate::ServiceError::NotRoot)
        );
        let mut as_root = system.clone();
        as_root.run_as = Some("root".into());
        assert!(matches!(
            resolve_install(&as_root, &env(&ctx, &everything, &account, true)),
            Err(crate::ServiceError::Invalid(message)) if message.contains("must not run as root")
        ));
        let mut unknown = system.clone();
        unknown.run_as = Some("ghost".into());
        assert!(matches!(
            resolve_install(&unknown, &env(&ctx, &everything, &account, true)),
            Err(crate::ServiceError::Invalid(message)) if message.contains("no such account")
        ));
        assert!(matches!(
            resolve_install(&system, &env(&ctx, &nothing, &account, true)),
            Err(crate::ServiceError::Invalid(message)) if message.contains("not a complete host install")
        ));
        let mut desktop_copy = env(&ctx, &everything, &account, true);
        desktop_copy.current_exe =
            Some(PathBuf::from("/Applications/Cognia.app/Contents/MacOS/cognia-server"));
        assert!(matches!(
            resolve_install(&system, &desktop_copy),
            Err(crate::ServiceError::Invalid(message)) if message.contains("--install-root")
        ));
    }

    #[test]
    fn a_user_install_is_refused_under_sudo() {
        let ctx = installer_ctx();
        let everything = |_: &Path| true;
        assert!(matches!(
            resolve_install(&request(ServiceScope::User), &env(&ctx, &everything, &account, true)),
            Err(crate::ServiceError::Invalid(message)) if message.contains("without sudo")
        ));
    }

    #[test]
    fn only_new_parents_inside_the_home_are_handed_over() {
        let existing = [PathBuf::from("/home/max/.local")];
        let exists = |dir: &Path| existing.iter().any(|known| known == dir);
        assert_eq!(
            missing_dirs_below(
                Path::new("/home/max/.local/share/cognia-server"),
                Path::new("/home/max"),
                &exists
            ),
            vec![PathBuf::from("/home/max/.local/share")]
        );
        // A data dir outside the home never touches system directories.
        assert!(missing_dirs_below(Path::new("/srv/cognia"), Path::new("/home/max"), &|_| false)
            .is_empty());
    }

    #[test]
    fn a_user_install_uses_the_installing_users_home() {
        let ctx = installer_ctx();
        let everything = |_: &Path| true;
        let resolved =
            resolve_install(&request(ServiceScope::User), &env(&ctx, &everything, &account, false))
                .unwrap();
        assert_eq!(resolved.owner, None);
        assert_eq!(resolved.options.run_as, None);
        assert_eq!(
            resolved.options.data_dir,
            PathBuf::from("/Users/admin/Library/Application Support/cognia-server")
        );
    }

    #[test]
    fn installing_creates_the_data_dir_and_key_then_loads_the_definition() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = crate::InstallerContext {
            home: dir.path().join("home"),
            uid: 501,
        };
        let everything = |_: &Path| true;
        let unpacked = dir.path().join("cognia-host-1.4.0-darwin-arm64");
        crate::test_support::write_install(&unpacked, "1.4.0", "darwin-arm64");
        let mut req = request(ServiceScope::User);
        req.data_dir = Some(dir.path().join("data"));
        req.install_root = Some(unpacked.clone());
        let io = RecordingIo::default();
        let report = install_server_service(&req, &env(&ctx, &everything, &account, false), &io)
            .unwrap();
        assert!(report.master_key_created);
        assert_eq!(report.installed_version, "1.4.0");
        let home = InstallHome::in_data_dir(&dir.path().join("data"));
        assert_eq!(home.current_version().as_deref(), Some("1.4.0"));
        assert_eq!(report.server_binary, home.current_layout().server_binary());
        assert!(report.server_binary.exists(), "the service runs the copy");
        assert!(is_master_key(&std::fs::read_to_string(&report.master_key).unwrap()));
        assert!(dir.path().join("data").join("logs").is_dir());
        assert_eq!(
            report.definition_path,
            dir.path().join("home/Library/LaunchAgents/com.cognia.server.plist")
        );
        assert!(io.ran.borrow().iter().any(|argv| argv.get(1).is_some_and(|a| a == "bootstrap")));
        // A second install keeps the key.
        let again = install_server_service(&req, &env(&ctx, &everything, &account, false), &io)
            .unwrap();
        assert!(!again.master_key_created);
    }

    #[derive(Default)]
    struct RecordingIo {
        ran: std::cell::RefCell<Vec<Vec<String>>>,
    }

    impl crate::ServiceIo for RecordingIo {
        fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
            std::fs::create_dir_all(path)
        }
        fn write_file(&self, path: &Path, contents: &str, mode: u32) -> std::io::Result<()> {
            std::fs::create_dir_all(path.parent().unwrap())?;
            crate::write_with_mode(path, contents.as_bytes(), mode)
        }
        fn remove_file(&self, path: &Path) -> std::io::Result<()> {
            std::fs::remove_file(path)
        }
        fn exists(&self, path: &Path) -> bool {
            path.exists()
        }
        fn run(&self, argv: &[String]) -> std::io::Result<crate::CommandOutcome> {
            self.ran.borrow_mut().push(argv.to_vec());
            Ok(crate::CommandOutcome {
                success: true,
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_current_account_can_be_looked_up() {
        let name = std::env::var("USER").unwrap_or_default();
        if name.is_empty() {
            return;
        }
        let record = lookup_account(&name).expect("current user resolves");
        assert_eq!(record.uid, unsafe { libc::geteuid() });
        assert!(lookup_account("no-such-cognia-account-xyz").is_none());
    }
}
