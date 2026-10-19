//! A real SFTP server, in memory (test support).
//!
//! It serves `russh_sftp`'s server protocol over one end of a
//! `tokio::io::duplex`, so code written against [`SftpSession`] is driven by
//! the actual wire protocol rather than by a stub of it: no SSH, no socket, no
//! filesystem. This module's own protocol tests and the host installer's SSH
//! adapter (ADR-0235 P6) share it; outside tests it is compiled only with the
//! `test-support` feature.
//!
//! `read` deliberately serves half of what is asked for, so a client's read
//! loop is exercised rather than assumed.

use std::collections::HashMap;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, Status, StatusCode, Version,
};

pub const DIR_MODE: u32 = 0x4000 | 0o755;
pub const FILE_MODE: u32 = 0x8000 | 0o644;

pub fn attrs(mode: u32, size: u64) -> FileAttributes {
    FileAttributes {
        size: Some(size),
        permissions: Some(mode),
        mtime: Some(1_700_000_000),
        ..Default::default()
    }
}

#[derive(Default)]
pub struct MemoryFs {
    /// path -> contents. A directory is an entry with `None`.
    nodes: HashMap<String, Option<Vec<u8>>>,
    handles: HashMap<String, String>,
    drained: HashMap<String, bool>,
    next_handle: u32,
}

impl MemoryFs {
    pub fn seeded() -> Self {
        let mut fs = Self::default();
        fs.nodes.insert("/srv".into(), None);
        fs.nodes.insert("/srv/logs".into(), None);
        fs.nodes
            .insert("/srv/Alpha.txt".into(), Some(b"alpha".to_vec()));
        fs.nodes
            .insert("/srv/beta.bin".into(), Some((0u8..200).collect()));
        fs
    }

    fn children(&self, dir: &str) -> Vec<(String, Option<usize>)> {
        let prefix = if dir.ends_with('/') {
            dir.to_string()
        } else {
            format!("{dir}/")
        };
        self.nodes
            .iter()
            .filter_map(|(path, body)| {
                let rest = path.strip_prefix(&prefix)?;
                if rest.is_empty() || rest.contains('/') {
                    return None;
                }
                Some((rest.to_string(), body.as_ref().map(|bytes| bytes.len())))
            })
            .collect()
    }

    fn mint(&mut self, path: &str) -> String {
        self.next_handle += 1;
        let handle = format!("h{}", self.next_handle);
        self.handles.insert(handle.clone(), path.to_string());
        handle
    }
}

impl russh_sftp::server::Handler for MemoryFs {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = if path == "." {
            "/srv".to_string()
        } else {
            path
        };
        Ok(Name {
            id,
            files: vec![File::dummy(resolved)],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        // A real server resolves `/srv/` and `/srv` to the same directory.
        // Normalizing here keeps the trailing-slash test about the client's
        // path joining rather than about this fixture's key lookup.
        let path = path.trim_end_matches('/').to_string();
        let path = if path.is_empty() {
            "/".to_string()
        } else {
            path
        };
        if !matches!(self.nodes.get(&path), Some(None)) {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = self.mint(&path);
        self.drained.insert(handle.clone(), false);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        if self.drained.get(&handle).copied().unwrap_or(true) {
            return Err(StatusCode::Eof);
        }
        self.drained.insert(handle.clone(), true);
        let dir = self.handles.get(&handle).cloned().unwrap_or_default();
        // `.` and `..` are what a real server sends, and dropping them is
        // the client's job. Sending them here is what makes that testable.
        let mut files = vec![
            File::new(".", attrs(DIR_MODE, 0)),
            File::new("..", attrs(DIR_MODE, 0)),
        ];
        for (name, size) in self.children(&dir) {
            files.push(match size {
                None => File::new(name, attrs(DIR_MODE, 0)),
                Some(len) => File::new(name, attrs(FILE_MODE, len as u64)),
            });
        }
        Ok(Name { id, files })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        self.drained.remove(&handle);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let exists = matches!(self.nodes.get(&filename), Some(Some(_)));
        if !exists {
            if !pflags.contains(russh_sftp::protocol::OpenFlags::CREATE) {
                return Err(StatusCode::NoSuchFile);
            }
            self.nodes.insert(filename.clone(), Some(Vec::new()));
        } else if pflags.contains(russh_sftp::protocol::OpenFlags::TRUNCATE) {
            self.nodes.insert(filename.clone(), Some(Vec::new()));
        }
        let handle = self.mint(&filename);
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = self.handles.get(&handle).cloned().unwrap_or_default();
        let body = match self.nodes.get(&path) {
            Some(Some(bytes)) => bytes.clone(),
            _ => return Err(StatusCode::NoSuchFile),
        };
        let start = offset as usize;
        if start >= body.len() {
            return Err(StatusCode::Eof);
        }
        // A real server is allowed to return less than asked for, and the
        // client's read loop has to cope. Halving the request is how that
        // gets exercised rather than assumed.
        let want = (len as usize).min(body.len() - start);
        let served = want.div_ceil(2).max(1);
        Ok(Data {
            id,
            data: body[start..start + served].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self.handles.get(&handle).cloned().unwrap_or_default();
        let Some(Some(body)) = self.nodes.get_mut(&path) else {
            return Err(StatusCode::NoSuchFile);
        };
        let start = offset as usize;
        if body.len() < start + data.len() {
            body.resize(start + data.len(), 0);
        }
        body[start..start + data.len()].copy_from_slice(&data);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        match self.nodes.get(&path) {
            Some(None) => Ok(Attrs {
                id,
                attrs: attrs(DIR_MODE, 0),
            }),
            Some(Some(body)) => Ok(Attrs {
                id,
                attrs: attrs(FILE_MODE, body.len() as u64),
            }),
            None => Err(StatusCode::NoSuchFile),
        }
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }
}

/// A client session to `fs`, served in memory for the rest of the test.
pub async fn connect(fs: MemoryFs) -> SftpSession {
    let (client, server) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        russh_sftp::server::run(server, fs).await;
    });
    SftpSession::new(client)
        .await
        .expect("SFTP handshake over the in-memory duplex")
}

#[cfg(test)]
mod tests {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    use super::*;

    #[tokio::test]
    async fn a_truncating_open_replaces_what_was_there() {
        let session = connect(MemoryFs::seeded()).await;
        let mut file = session
            .open_with_flags(
                "/srv/beta.bin",
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            )
            .await
            .expect("open");
        file.write_all(b"new").await.expect("write");
        file.shutdown().await.expect("close");
        assert_eq!(session.read("/srv/beta.bin").await.expect("read"), b"new");
        assert_eq!(
            session.metadata("/srv/beta.bin").await.expect("stat").size,
            Some(3)
        );
    }
}
