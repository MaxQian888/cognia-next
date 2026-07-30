//! Host-owned Skills catalog and transactional upload/install service.
//!
//! Upload handles are resolved from the execution host's data directory. A
//! controller therefore cannot open a bundle on one host and commit it on
//! another, and the temporary files never use the task workspace.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

use crate::skills::{
    bundle::{BundleUploadHandle, BundleUploadOpenRequest, SkillBundleUploadService},
    install::{
        skills_install_atomic_at_roots, InstallSkillMirroredResponse, SkillInstallRoots,
        SkillsTarget,
    },
    native::{self, UninstallResult},
    types::NativeSkill,
};

use super::dispatch_host::DispatchHost;

static SERVICES: Lazy<Mutex<HashMap<PathBuf, Arc<SkillBundleUploadService>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static UPLOAD_OWNERS: Lazy<Mutex<HashMap<(PathBuf, String), String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillsCatalog {
    pub cognia: Vec<NativeSkill>,
    pub claude: Vec<NativeSkill>,
    pub codex: Vec<NativeSkill>,
}

fn roots(host: &DispatchHost) -> Result<SkillInstallRoots, String> {
    let data_dir = host.data_dir()?;
    let home = dirs::home_dir();
    Ok(SkillInstallRoots {
        cognia: Some(data_dir.join("cognia").join("skills")),
        claude: home
            .as_ref()
            .map(|home| home.join(".claude").join("skills")),
        codex: home
            .as_ref()
            .map(|home| home.join(".agents").join("skills")),
    })
}

fn upload_root(host: &DispatchHost) -> Result<PathBuf, String> {
    Ok(host
        .data_dir()?
        .join("cognia")
        .join("skills")
        .join(".uploads"))
}

fn service(host: &DispatchHost) -> Result<Arc<SkillBundleUploadService>, String> {
    let upload_root = upload_root(host)?;
    let mut services = SERVICES.lock();
    if let Some(service) = services.get(&upload_root) {
        return Ok(Arc::clone(service));
    }
    let service = Arc::new(SkillBundleUploadService::new(upload_root.clone())?);
    services.insert(upload_root, Arc::clone(&service));
    Ok(service)
}

fn scan(root: Option<&Path>) -> Result<Vec<NativeSkill>, String> {
    match root {
        Some(root) => native::skills_scan_dir(root.to_string_lossy().into_owned()),
        None => Ok(Vec::new()),
    }
}

pub fn catalog_get(host: &DispatchHost) -> Result<HostSkillsCatalog, String> {
    let roots = roots(host)?;
    Ok(HostSkillsCatalog {
        cognia: scan(roots.cognia.as_deref())?,
        claude: scan(roots.claude.as_deref())?,
        codex: scan(roots.codex.as_deref())?,
    })
}

pub fn upload_open(
    host: &DispatchHost,
    device_id: &str,
    request: BundleUploadOpenRequest,
) -> Result<BundleUploadHandle, String> {
    let handle = service(host)?.open(request)?;
    UPLOAD_OWNERS.lock().insert(
        (upload_root(host)?, handle.handle_id.clone()),
        device_id.to_owned(),
    );
    Ok(handle)
}

pub fn upload_write(
    host: &DispatchHost,
    device_id: &str,
    handle_id: &str,
    offset: u64,
    data_base64: &str,
    chunk_hash: &str,
) -> Result<u64, String> {
    require_upload_owner(host, device_id, handle_id)?;
    service(host)?.write_chunk(handle_id, offset, data_base64, chunk_hash)
}

pub fn upload_commit(host: &DispatchHost, device_id: &str, handle_id: &str) -> Result<(), String> {
    require_upload_owner(host, device_id, handle_id)?;
    service(host)?.commit(handle_id)
}

pub fn upload_abort(host: &DispatchHost, device_id: &str, handle_id: &str) -> Result<(), String> {
    require_upload_owner(host, device_id, handle_id)?;
    let result = service(host)?.abort(handle_id);
    UPLOAD_OWNERS
        .lock()
        .remove(&(upload_root(host)?, handle_id.to_owned()));
    result
}

pub fn install_atomic(
    host: &DispatchHost,
    device_id: &str,
    handle_id: &str,
) -> Result<InstallSkillMirroredResponse, String> {
    require_upload_owner(host, device_id, handle_id)?;
    let service = service(host)?;
    let request = service.take(handle_id);
    UPLOAD_OWNERS
        .lock()
        .remove(&(upload_root(host)?, handle_id.to_owned()));
    skills_install_atomic_at_roots(&roots(host)?, request?)
}

fn require_upload_owner(
    host: &DispatchHost,
    device_id: &str,
    handle_id: &str,
) -> Result<(), String> {
    let owners = UPLOAD_OWNERS.lock();
    match owners.get(&(upload_root(host)?, handle_id.to_owned())) {
        Some(owner) if owner == device_id => Ok(()),
        Some(_) => Err("REMOTE_SCOPE_DENIED: Skill upload belongs to another device".into()),
        None => Err("REMOTE_RESPONSE_STALE: unknown Skill upload handle".into()),
    }
}

pub fn uninstall(
    host: &DispatchHost,
    target: SkillsTarget,
    dir_name: &str,
) -> Result<UninstallResult, String> {
    if dir_name.is_empty()
        || dir_name == "."
        || dir_name == ".."
        || dir_name.contains('/')
        || dir_name.contains('\\')
    {
        return Err("invalid skill directory name".into());
    }
    let roots = roots(host)?;
    let root = match target {
        SkillsTarget::Cognia => roots.cognia,
        SkillsTarget::Claude => roots.claude,
        SkillsTarget::Codex => roots.codex,
    }
    .ok_or_else(|| "skill target root is unavailable".to_string())?;
    let directory = root.join(dir_name);
    let removed = if directory.symlink_metadata().is_ok() {
        let metadata = directory
            .symlink_metadata()
            .map_err(|error| format!("inspect skill {}: {error}", directory.display()))?;
        if metadata.file_type().is_symlink() || metadata.is_file() {
            std::fs::remove_file(&directory)
        } else {
            std::fs::remove_dir_all(&directory)
        }
        .map_err(|error| format!("remove skill {}: {error}", directory.display()))?;
        true
    } else {
        false
    };
    Ok(UninstallResult {
        removed,
        directory: directory.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headless::HeadlessServices;

    #[test]
    fn upload_handle_is_created_under_the_host_service() {
        let host = DispatchHost::Headless(HeadlessServices::stub_for_tests());
        let handle = upload_open(
            &host,
            "device-a",
            BundleUploadOpenRequest {
                expected_size: 2,
                expected_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
                    .into(),
            },
        )
        .expect("open");
        assert!(!handle.handle_id.is_empty());
    }

    #[test]
    fn upload_handle_is_bound_to_the_device_that_opened_it() {
        let host = DispatchHost::Headless(HeadlessServices::stub_for_tests());
        let handle = upload_open(
            &host,
            "device-a",
            BundleUploadOpenRequest {
                expected_size: 2,
                expected_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
                    .into(),
            },
        )
        .expect("open");

        assert!(upload_commit(&host, "device-b", &handle.handle_id)
            .unwrap_err()
            .starts_with("REMOTE_SCOPE_DENIED"));
        upload_abort(&host, "device-a", &handle.handle_id).unwrap();
    }

    #[test]
    fn uninstall_rejects_path_traversal() {
        let host = DispatchHost::Headless(HeadlessServices::stub_for_tests());
        let error = uninstall(&host, SkillsTarget::Cognia, "../escape").unwrap_err();
        assert_eq!(error, "invalid skill directory name");
    }
}
