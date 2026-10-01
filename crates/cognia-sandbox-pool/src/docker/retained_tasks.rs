//! Host-owned task-to-runtime index. Cleanup never starts an unrelated image.
use super::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Location {
    pub container: String,
    pub project: String,
    pub digest: String,
}
#[derive(Default)]
pub(super) struct RetainedTasks {
    path: Option<PathBuf>,
    tasks: HashMap<String, Vec<Location>>,
}
fn key(task: &str, device: Option<&str>) -> String {
    serde_json::to_string(&(task, device)).expect("identity serializes")
}
impl RetainedTasks {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let tasks = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(_) => return Err("Cannot inspect retained task index".into()),
            Ok(meta) => {
                if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
                    return Err("Invalid retained task index".into());
                }
                let bytes = std::fs::read(&path).map_err(|_| "Cannot read retained task index")?;
                let tasks: HashMap<String, Vec<Location>> =
                    serde_json::from_slice(&bytes).map_err(|_| "Invalid retained task index")?;
                if tasks.len() > 10000
                    || tasks.values().any(|places| {
                        places.len() > 256
                            || places.iter().any(|p| {
                                p.container.is_empty()
                                    || p.container.len() > 256
                                    || p.project.is_empty()
                                    || p.project.len() > 256
                                    || !p.digest.starts_with("sha256:")
                                    || p.digest.len() != 71
                            })
                    })
                {
                    return Err("Invalid retained task index limits".into());
                }
                tasks
            }
        };
        Ok(Self {
            path: Some(path),
            tasks,
        })
    }
    fn save(&self, tasks: &HashMap<String, Vec<Location>>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let parent = path.parent().ok_or("Missing task index parent")?;
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create task index directory")?;
        let temp = parent.join(format!(".retained-tasks-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(tasks).map_err(|_| "Cannot encode retained task index")?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Retained task index exceeds limit".into());
        }
        let result = (|| {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temp)
                .map_err(|_| "Cannot create task index")?;
            file.write_all(&bytes)
                .map_err(|_| "Cannot write task index")?;
            file.sync_all().map_err(|_| "Cannot sync task index")?;
            std::fs::rename(&temp, path).map_err(|_| "Cannot replace task index")
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result.map_err(str::to_string)
    }
    pub fn remember(
        &mut self,
        task: &str,
        device: Option<&str>,
        place: Location,
    ) -> Result<(), String> {
        let mut tasks = self.tasks.clone();
        let locations = tasks.entry(key(task, device)).or_default();
        if !locations.contains(&place) {
            locations.push(place);
        }
        if tasks.len() > 10000 || tasks.values().any(|items| items.len() > 256) {
            return Err("Retained task index exceeds limit".into());
        }
        self.save(&tasks)?;
        self.tasks = tasks;
        Ok(())
    }
    pub fn locations(&self, task: &str, device: Option<&str>) -> Vec<Location> {
        self.tasks
            .get(&key(task, device))
            .cloned()
            .unwrap_or_default()
    }
    pub fn forget(&mut self, task: &str, device: Option<&str>) -> Result<(), String> {
        let mut tasks = self.tasks.clone();
        tasks.remove(&key(task, device));
        self.save(&tasks)?;
        self.tasks = tasks;
        Ok(())
    }
}
impl DockerSandboxBackend {
    pub fn configure_retained_tasks(&self, data_dir: &Path) -> Result<(), String> {
        *self.retained_tasks.lock() =
            RetainedTasks::load(data_dir.join("sandbox-retained-tasks.json"))?;
        Ok(())
    }
    pub(super) fn remember_retained_task(
        &self,
        config: &ExternalAgentSpawnConfig,
        container: &str,
        environment: &EnvironmentSpec,
    ) -> Result<(), SandboxSpawnError> {
        let Some(raw) = config.env.get(cognia_sandboxd::gateway_task::PAYLOAD_ENV) else {
            return Ok(());
        };
        let payload: Value = serde_json::from_str(raw).map_err(|_| {
            SandboxSpawnError::refused("sandbox_gateway_task_invalid", "Invalid task payload")
        })?;
        let task = payload
            .get("taskId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                SandboxSpawnError::refused("sandbox_gateway_task_invalid", "Missing task identity")
            })?;
        self.retained_tasks
            .lock()
            .remember(
                task,
                payload.get("originDeviceId").and_then(Value::as_str),
                Location {
                    container: container.into(),
                    project: environment.project_id.clone(),
                    digest: environment.spec_digest.clone(),
                },
            )
            .map_err(|error| SandboxSpawnError::fault("sandbox_task_index_failed", error))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn index_recovers_locations_and_isolates_device_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.json");
        let mut store = RetainedTasks::load(file.clone()).unwrap();
        let location = Location {
            container: "runtime".into(),
            project: "project".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
        };
        store.remember("task", Some("device-a"), location).unwrap();
        let mut restored = RetainedTasks::load(file).unwrap();
        assert_eq!(restored.locations("task", Some("device-a")).len(), 1);
        assert!(restored.locations("task", Some("device-b")).is_empty());
        restored.forget("task", Some("device-a")).unwrap();
        assert!(restored.locations("task", Some("device-a")).is_empty());
    }
}
