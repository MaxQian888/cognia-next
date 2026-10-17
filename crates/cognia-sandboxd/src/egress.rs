//! Local Docker's trusted egress lease. This module relays bytes only; policy
//! matching and upstream dialing belong to the Host FilteringProxy.
use std::{collections::BTreeMap, io, time::Duration};

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;
pub const LEASE_PATH: &str = "/run/cognia-egress/lease";
pub const GATE_TIMEOUT: Duration = Duration::from_secs(30);
pub const PROBE_REQUEST: &[u8] = b"COGNIA-EGRESS-PROBE\r\n\r\n";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EgressConfig {
    pub version: u32,
    pub policy_digest: String,
}

impl EgressConfig {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != VERSION
            || self.policy_digest.len() != 64
            || !self.policy_digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(refused("invalid egress version or policy digest"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ready {
    pub version: u32,
    pub generation: String,
    pub policy_digest: String,
    pub port: u16,
}

impl Ready {
    pub fn validate(&self) -> io::Result<()> {
        EgressConfig {
            version: self.version,
            policy_digest: self.policy_digest.clone(),
        }
        .validate()?;
        if self.port == 0
            || self.generation.is_empty()
            || self.generation.len() > 128
            || !self
                .generation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(refused("invalid egress generation or relay port"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: u32,
    pub generation: String,
}

impl Release {
    pub fn verify(&self, ready: &Ready) -> io::Result<()> {
        if self.version != VERSION || self.generation != ready.generation {
            return Err(refused("stale egress release generation"));
        }
        Ok(())
    }
}

fn refused(detail: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("sandbox_egress_unenforceable: {detail}"),
    )
}

fn proxy_env(port: u16, env: &mut BTreeMap<String, String>) {
    let url = format!("http://127.0.0.1:{port}");
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        env.insert(key.into(), url.clone());
    }
    for key in ["NO_PROXY", "no_proxy"] {
        env.insert(key.into(), "localhost,127.0.0.1,::1".into());
    }
}

pub fn apply_env(
    config: Option<&EgressConfig>,
    env: &mut BTreeMap<String, String>,
) -> io::Result<()> {
    if let Some(config) = config {
        let ready = live(config)?;
        proxy_env(ready.port, env);
    }
    Ok(())
}

pub fn require_live(config: Option<&EgressConfig>) -> io::Result<()> {
    config.map(live).transpose().map(|_| ())
}

pub fn await_live(config: Option<&EgressConfig>) -> io::Result<()> {
    let Some(config) = config else { return Ok(()) };
    config.validate()?;
    let until = std::time::Instant::now() + GATE_TIMEOUT;
    loop {
        match live(config) {
            Ok(_) => return Ok(()),
            Err(error) if std::time::Instant::now() >= until => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

#[cfg(not(unix))]
pub fn live(_config: &EgressConfig) -> io::Result<Ready> {
    Err(refused("local egress lease requires Unix"))
}

#[cfg(unix)]
pub use unix::live;
#[cfg(unix)]
pub(crate) use unix::{probe, LeaseGuard};

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        fs::{self, File, OpenOptions},
        io::{Read, Write},
        net::TcpStream,
        os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Lease {
        ready: Ready,
        pid: u32,
        process_token: String,
        expires_ms: u64,
    }

    fn now_ms() -> io::Result<u64> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .map_err(|_| refused("clock predates epoch"))
    }

    #[cfg(target_os = "linux")]
    fn process_token(pid: u32) -> io::Result<String> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
        stat.rsplit_once(") ")
            .and_then(|(_, fields)| fields.split_whitespace().nth(19))
            .map(str::to_owned)
            .ok_or_else(|| refused("bridge process identity unavailable"))
    }

    #[cfg(not(target_os = "linux"))]
    fn process_token(pid: u32) -> io::Result<String> {
        if unsafe { libc::kill(pid as i32, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(pid.to_string())
    }

    fn read_at(path: &Path, owner: u32, config: &EgressConfig) -> io::Result<Ready> {
        config.validate()?;
        if crate::start_gate::inspect_marker(path, owner)?
            != crate::start_gate::MarkerState::Released
        {
            return Err(refused("egress gate is not released"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(refused("invalid egress lease"));
        }
        let lease: Lease =
            serde_json::from_slice(&bytes).map_err(|_| refused("invalid egress lease"))?;
        lease.ready.validate()?;
        if lease.ready.policy_digest != config.policy_digest
            || lease.expires_ms <= now_ms()?
            || lease.process_token != process_token(lease.pid)?
        {
            return Err(refused("expired or mismatched egress lease"));
        }
        Ok(lease.ready)
    }

    pub fn live(config: &EgressConfig) -> io::Result<Ready> {
        read_at(Path::new(LEASE_PATH), 0, config)
    }

    pub(crate) struct LeaseGuard {
        path: PathBuf,
        _lock: File,
        ready: Ready,
        duration: Duration,
        released: bool,
    }

    impl LeaseGuard {
        pub(crate) fn new(ready: Ready, duration: Duration) -> io::Result<Self> {
            Self::at(Path::new(LEASE_PATH), ready, duration)
        }

        fn at(path: &Path, ready: Ready, duration: Duration) -> io::Result<Self> {
            ready.validate()?;
            let lock_path = path.with_file_name("lock");
            crate::start_gate::release_marker(&lock_path)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(lock_path)?;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(refused("another egress bridge owns this runtime"));
            }
            // A prior process may have been killed without running Drop.
            match fs::remove_file(path) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
            Ok(Self {
                path: path.into(),
                _lock: lock,
                ready,
                duration,
                released: false,
            })
        }

        pub(crate) fn release(&mut self, release: &Release) -> io::Result<()> {
            release.verify(&self.ready)?;
            self.publish()?;
            self.released = true;
            Ok(())
        }

        pub(crate) fn renew(&mut self) -> io::Result<()> {
            if self.released {
                self.publish()?;
            }
            Ok(())
        }

        fn publish(&self) -> io::Result<()> {
            let lease = Lease {
                ready: self.ready.clone(),
                pid: std::process::id(),
                process_token: process_token(std::process::id())?,
                expires_ms: now_ms()? + self.duration.as_millis() as u64,
            };
            let tmp = self
                .path
                .with_file_name(format!("lease-{}", self.ready.generation));
            let result = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&tmp)?;
                serde_json::to_writer(&mut file, &lease)?;
                file.flush()?;
                fs::rename(&tmp, &self.path)
            })();
            if result.is_err() {
                let _ = fs::remove_file(tmp);
            }
            result
        }
    }

    impl Drop for LeaseGuard {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            #[cfg(target_os = "linux")]
            if self.released && std::process::id() != 1 {
                // PID 1 is our init/serve, never an image's entrypoint. Avoid
                // signaling an unrelated host init when exercising the relay.
                if let (Ok(current), Ok(init)) =
                    (std::env::current_exe(), fs::read_link("/proc/1/exe"))
                {
                    if current == init {
                        unsafe {
                            libc::kill(1, libc::SIGTERM);
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn probe(port: u16) -> io::Result<()> {
        let address = ([127, 0, 0, 1], port).into();
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(PROBE_REQUEST)?;
        let mut response = [0; 13];
        stream.read_exact(&mut response)?;
        if &response != b"HTTP/1.1 400 " {
            return Err(refused("FilteringProxy probe failed"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn ready() -> Ready {
            Ready {
                version: VERSION,
                generation: "test-generation".into(),
                policy_digest: "a".repeat(64),
                port: 8123,
            }
        }
        #[test]
        fn egress_gate_requires_release_fresh_generation_and_live_lease() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("private/lease");
            let config = EgressConfig {
                version: VERSION,
                policy_digest: "a".repeat(64),
            };
            let owner = unsafe { libc::geteuid() };
            let mut lease = LeaseGuard::at(&path, ready(), Duration::from_secs(30)).unwrap();
            assert!(read_at(&path, owner, &config).is_err());
            assert!(lease
                .release(&Release {
                    version: VERSION,
                    generation: "stale".into()
                })
                .is_err());
            assert!(!path.exists());
            lease
                .release(&Release {
                    version: VERSION,
                    generation: "test-generation".into(),
                })
                .unwrap();
            assert_eq!(read_at(&path, owner, &config).unwrap().port, 8123);
            assert!(LeaseGuard::at(&path, ready(), Duration::from_secs(30)).is_err());
            let different = EgressConfig {
                policy_digest: "b".repeat(64),
                ..config.clone()
            };
            assert!(read_at(&path, owner, &different).is_err());
            lease.renew().unwrap();
            drop(lease);
            assert!(read_at(&path, owner, &config).is_err());
        }
        #[test]
        fn egress_expired_lease_cannot_release_gate() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("private/lease");
            let mut lease = LeaseGuard::at(&path, ready(), Duration::ZERO).unwrap();
            lease
                .release(&Release {
                    version: VERSION,
                    generation: "test-generation".into(),
                })
                .unwrap();
            let config = EgressConfig {
                version: VERSION,
                policy_digest: "a".repeat(64),
            };
            assert!(read_at(&path, unsafe { libc::geteuid() }, &config).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn egress_proxy_environment_is_last_and_loopback_only() {
        let mut env = BTreeMap::from([
            ("HTTP_PROXY".into(), "http://attacker".into()),
            ("NO_PROXY".into(), "*".into()),
            ("no_proxy".into(), "*".into()),
        ]);
        proxy_env(1234, &mut env);
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert_eq!(env[key], "http://127.0.0.1:1234");
        }
        assert_eq!(env["NO_PROXY"], "localhost,127.0.0.1,::1");
        assert_eq!(env["no_proxy"], "localhost,127.0.0.1,::1");
    }
    #[test]
    fn egress_remote_default_never_waits_for_local_bridge() {
        let config = crate::env::RuntimeConfigV1::default();
        assert!(config.egress.is_none());
        assert!(serde_json::to_value(&config)
            .unwrap()
            .get("egress")
            .is_none());
        await_live(config.egress.as_ref()).unwrap();
        require_live(config.egress.as_ref()).unwrap();
        let mut env = BTreeMap::from([("HTTP_PROXY".into(), "original".into())]);
        apply_env(None, &mut env).unwrap();
        assert_eq!(env["HTTP_PROXY"], "original");
    }
}
