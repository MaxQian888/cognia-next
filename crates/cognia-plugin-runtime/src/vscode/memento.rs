//! Persisted `globalState` / `workspaceState` for VS Code extensions.
//!
//! The extension host keeps a Memento in memory and reports every write as a
//! `memento:write` notification; the sidecar's stdout reader applies it here
//! instead of forwarding it to the renderer. Each scope is one JSON object in
//! the extension's state directory (`<data>/cognia/vscode-extension-state/<id>`),
//! outside its install directory, so it survives a restart, an update and a
//! reinstall. Writes are atomic (temporary file, then rename).

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Largest a scope's file may grow. A write that would exceed it is refused,
/// so one extension cannot fill the disk through its Memento.
pub const MAX_MEMENTO_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct MementoStore {
    path: PathBuf,
    values: Map<String, Value>,
}

impl MementoStore {
    /// Open the store at `path`, starting empty when the file is absent. A
    /// file that is not a JSON object is set aside (`.corrupt`) rather than
    /// trusted or silently discarded.
    pub fn open(path: PathBuf) -> io::Result<Self> {
        let values = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(values)) => values,
                _ => {
                    let aside = path.with_extension("json.corrupt");
                    log::warn!(
                        "VS Code memento {} is not a JSON object; moved aside",
                        path.display()
                    );
                    std::fs::rename(&path, aside)?;
                    Map::new()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Map::new(),
            Err(error) => return Err(error),
        };
        Ok(Self { path, values })
    }

    pub fn values(&self) -> &Map<String, Value> {
        &self.values
    }

    /// Set `key` (or remove it, with `None`) and write the scope back.
    pub fn apply(&mut self, key: &str, value: Option<Value>) -> io::Result<()> {
        let previous = match value {
            Some(value) => self.values.insert(key.to_string(), value),
            None => self.values.remove(key),
        };
        let bytes = serde_json::to_vec(&self.values).map_err(io::Error::other)?;
        if bytes.len() > MAX_MEMENTO_BYTES {
            // Undo, so memory and disk keep agreeing.
            match previous {
                Some(previous) => {
                    self.values.insert(key.to_string(), previous);
                }
                None => {
                    self.values.remove(key);
                }
            }
            return Err(io::Error::other(format!(
                "VS Code memento would exceed {MAX_MEMENTO_BYTES} bytes"
            )));
        }
        write_atomically(&self.path, &bytes)
    }
}

/// Both scopes of one activation. `workspace` is absent with no workspace open.
#[derive(Debug)]
pub struct ExtensionMementos {
    pub global: MementoStore,
    pub workspace: Option<MementoStore>,
}

impl ExtensionMementos {
    /// Apply one `memento:write` notification's parameters.
    pub fn apply_write(&mut self, params: &Value) -> io::Result<()> {
        let key = params
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| io::Error::other("memento write without a key"))?;
        let store = match params.get("scope").and_then(Value::as_str) {
            Some("global") => &mut self.global,
            Some("workspace") => self
                .workspace
                .as_mut()
                .ok_or_else(|| io::Error::other("workspaceState written with no workspace open"))?,
            _ => return Err(io::Error::other("memento write with an unknown scope")),
        };
        let deleted = params
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let value = if deleted {
            None
        } else {
            Some(params.get("value").cloned().unwrap_or(Value::Null))
        };
        store.apply(key, value)
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_survive_reopening_and_deletes_remove() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("global").join("state.json");
        let mut store = MementoStore::open(path.clone()).unwrap();
        store.apply("count", Some(json!(3))).unwrap();
        store.apply("name", Some(json!({ "a": [1, 2] }))).unwrap();
        store.apply("name", None).unwrap();
        let reopened = MementoStore::open(path).unwrap();
        assert_eq!(reopened.values().get("count"), Some(&json!(3)));
        assert!(reopened.values().get("name").is_none());
    }

    #[test]
    fn a_corrupt_file_is_set_aside_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, b"[1,2,3]").unwrap();
        let store = MementoStore::open(path.clone()).unwrap();
        assert!(store.values().is_empty());
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn an_oversized_write_is_refused_and_undone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = MementoStore::open(path.clone()).unwrap();
        store.apply("small", Some(json!("ok"))).unwrap();
        let huge = "x".repeat(MAX_MEMENTO_BYTES + 1);
        assert!(store.apply("big", Some(json!(huge))).is_err());
        assert!(store.values().get("big").is_none());
        assert_eq!(
            MementoStore::open(path).unwrap().values().len(),
            1,
            "disk still holds only the small value"
        );
    }

    #[test]
    fn notifications_route_by_scope() {
        let dir = tempfile::tempdir().unwrap();
        let mut mementos = ExtensionMementos {
            global: MementoStore::open(dir.path().join("g.json")).unwrap(),
            workspace: None,
        };
        mementos
            .apply_write(&json!({ "scope": "global", "key": "k", "value": 1, "deleted": false }))
            .unwrap();
        assert_eq!(mementos.global.values().get("k"), Some(&json!(1)));
        assert!(mementos
            .apply_write(&json!({ "scope": "workspace", "key": "k", "value": 1 }))
            .is_err());
        mementos
            .apply_write(&json!({ "scope": "global", "key": "k", "deleted": true }))
            .unwrap();
        assert!(mementos.global.values().is_empty());
        assert!(mementos.apply_write(&json!({ "scope": "global" })).is_err());
    }
}
