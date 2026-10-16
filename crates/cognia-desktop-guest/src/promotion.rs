//! Root receiver copies inert files through pinned directory descriptors. Git is
//! never invoked here; the Host's independent raw-tree proof is authoritative.
use crate::protocol::{invalid, Manifest, Request};
use cognia_desktop_guest::source_tree::{
    SourceTreeBuilder, SourceTreeEntry, MAX_SOURCE_BYTES, MAX_SOURCE_FILES,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub(crate) const IMPORTS: &str = "/var/lib/cognia-desktop/imports";
const PROMOTIONS: &str = "/var/lib/cognia-desktop/promotions";
const WORKSPACE: &str = "/var/lib/cognia-desktop/workspace";
const RECEIPTS: &str = "/var/lib/cognia-desktop/receipts";

pub(crate) fn directory(path: &Path, mode: u32, uid: u32, gid: u32, fresh: bool) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match fs::DirBuilder::new().mode(mode).create(path) {
        Ok(()) => {
            let file = open_directory(path)?;
            set_owner_mode(&file, uid, gid, mode)?;
        }
        Err(error) if !fresh && error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let file = open_directory(path)?;
    let meta = file.metadata()?;
    if meta.uid() != uid || meta.gid() != gid || meta.mode() & 0o7777 != mode {
        return Err(invalid());
    }
    Ok(())
}
fn open_directory(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}
fn set_owner_mode(file: &File, uid: u32, gid: u32, mode: u32) -> io::Result<()> {
    if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    file.set_permissions(fs::Permissions::from_mode(mode))
}
fn name(bytes: &[u8]) -> io::Result<CString> {
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(invalid());
    }
    CString::new(bytes).map_err(|_| invalid())
}
// openat2 rejects even same-device bind mounts, magic links and intermediate
// symlinks. A kernel without this mandatory primitive is refused.
fn child(parent: &File, bytes: &[u8], flags: i32, mode: u32) -> io::Result<File> {
    #[repr(C)]
    struct How {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    let name = name(bytes)?;
    let how = How {
        flags: (flags | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
        mode: mode as u64,
        resolve: 0x01 | 0x02 | 0x04 | 0x08,
    }; // NO_XDEV, NO_MAGICLINKS, NO_SYMLINKS, BENEATH
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<How>(),
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
fn make_dir(parent: &File, bytes: &[u8]) -> io::Result<File> {
    let name = name(bytes)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    child(parent, bytes, libc::O_RDONLY | libc::O_DIRECTORY, 0)
}
fn names(directory: &File) -> io::Result<Vec<Vec<u8>>> {
    let fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut result = Vec::new();
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                if io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(io::Error::last_os_error());
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            name(bytes)?;
            result.push(bytes.to_vec());
            if result.len() > MAX_SOURCE_FILES {
                return Err(invalid());
            }
        }
        result.sort();
        Ok(result)
    })();
    unsafe {
        libc::closedir(stream);
    }
    result
}
fn inert(file: &File, device: u64) -> io::Result<fs::Metadata> {
    let meta = file.metadata()?;
    if meta.dev() != device
        || meta.mode() & 0o7000 != 0
        || (!meta.is_dir() && (!meta.is_file() || meta.nlink() != 1))
    {
        return Err(invalid());
    }
    let capability = c"security.capability";
    let size = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            capability.as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if size >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ENODATA) {
        return Err(invalid());
    }
    Ok(meta)
}

pub(crate) fn stage(request: &Request) -> io::Result<(PathBuf, PathBuf)> {
    // Two inert trees may coexist until atomic promotion. Fail before parsing
    // rather than allowing a compressed bundle to consume the supervisor disk.
    let mut space = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(c"/var/lib/cognia-desktop".as_ptr(), space.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let space = unsafe { space.assume_init() };
    let available = (space.f_bavail as u128) * (space.f_frsize as u128);
    if available
        < (2 * MAX_SOURCE_BYTES
            + crate::protocol::BUNDLE_LIMIT
            + 2 * crate::protocol::ACCEPTANCE_LIMIT
            + 128 * 1024 * 1024) as u128
    {
        return Err(invalid());
    }
    directory(Path::new(IMPORTS), 0o711, 0, 0, false)?;
    let root = Path::new(IMPORTS).join(&request.operation_id);
    directory(&root, 0o710, 0, 1001, true)?;
    let input = root.join("input");
    let output = root.join("output");
    directory(&input, 0o750, 0, 1001, true)?;
    directory(&output, 0o700, 1001, 1001, true)?;
    let mut file = input_file(&input, "request.json")?;
    serde_json::to_writer(&mut file, request).map_err(|_| invalid())?;
    file.sync_all()?;
    Ok((input, output))
}
pub(crate) fn input_file(input: &Path, filename: &str) -> io::Result<File> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o440)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(input.join(filename))?;
    set_owner_mode(&file, 0, 1001, 0o440)?;
    Ok(file)
}

struct CopyState<'a> {
    deadline: Instant,
    count: usize,
    bytes: u64,
    metadata_bytes: usize,
    proof: SourceTreeBuilder,
    expected: BTreeMap<&'a str, (&'a str, u64)>,
    seen: BTreeSet<String>,
}
impl CopyState<'_> {
    fn copy(
        &mut self,
        source: &File,
        destination: &File,
        prefix: &[u8],
        acceptance: bool,
        device: u64,
    ) -> io::Result<()> {
        if prefix.len() > 4096 || prefix.iter().filter(|byte| **byte == b'/').count() > 128 {
            return Err(invalid());
        }
        for entry in names(source)? {
            if Instant::now() >= self.deadline {
                return Err(invalid());
            }
            let mut path = prefix.to_vec();
            if !path.is_empty() {
                path.push(b'/');
            }
            path.extend_from_slice(&entry);
            self.metadata_bytes = self
                .metadata_bytes
                .checked_add(path.len())
                .ok_or_else(invalid)?;
            self.count += 1;
            if self.count > MAX_SOURCE_FILES * 2
                || self.metadata_bytes > 32 * 1024 * 1024
                || path.len() > 4096
            {
                return Err(invalid());
            }
            // Inspect without opening a device or FIFO. The parser namespace is
            // dead and its dedicated UID has no other live process; reopen only
            // an independently observed regular file/directory, then pin identity.
            let probe = child(source, &entry, libc::O_PATH, 0)?;
            let inspected = probe.metadata()?;
            if !inspected.is_file() && !inspected.is_dir() {
                return Err(invalid());
            }
            let mut input = child(source, &entry, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
            let meta = inert(&input, device)?;
            if meta.ino() != inspected.ino() || meta.dev() != inspected.dev() {
                return Err(invalid());
            }
            if meta.is_dir() {
                let output = make_dir(destination, &entry)?;
                self.copy(&input, &output, &path, acceptance, device)?;
                set_owner_mode(
                    &output,
                    if acceptance { 0 } else { 1000 },
                    if acceptance { 0 } else { 1000 },
                    if acceptance { 0o555 } else { 0o755 },
                )?;
                output.sync_all()?;
            } else {
                self.bytes = self.bytes.checked_add(meta.len()).ok_or_else(invalid)?;
                if self.bytes > MAX_SOURCE_BYTES + 32 * 1024 * 1024 {
                    return Err(invalid());
                }
                let mut output = child(
                    destination,
                    &entry,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                    0o600,
                )?;
                let mut digest = Sha256::new();
                let mut length = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    if Instant::now() >= self.deadline {
                        return Err(invalid());
                    }
                    let read = input.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    length = length.checked_add(read as u64).ok_or_else(invalid)?;
                    if length > meta.len() {
                        return Err(invalid());
                    }
                    digest.update(&buffer[..read]);
                    output.write_all(&buffer[..read])?;
                }
                if length != meta.len() {
                    return Err(invalid());
                }
                let digest: [u8; 32] = digest.finalize().into();
                if acceptance {
                    let path = std::str::from_utf8(&path).map_err(|_| invalid())?;
                    let expected = self.expected.get(path).ok_or_else(invalid)?;
                    if expected.1 != length
                        || expected.0 != hex::encode(digest)
                        || !self.seen.insert(path.into())
                    {
                        return Err(invalid());
                    }
                } else if path.split(|byte| *byte == b'/').next() != Some(b".git") {
                    self.proof
                        .push(SourceTreeEntry {
                            path,
                            executable: meta.mode() & 0o111 != 0,
                            bytes: length,
                            content_sha256: digest,
                        })
                        .map_err(|_| invalid())?;
                }
                set_owner_mode(
                    &output,
                    if acceptance { 0 } else { 1000 },
                    if acceptance { 0 } else { 1000 },
                    if acceptance {
                        0o444
                    } else if meta.mode() & 0o111 != 0 {
                        0o755
                    } else {
                        0o644
                    },
                )?;
                output.sync_all()?;
            }
        }
        Ok(())
    }
}

pub(crate) fn promote(
    request: &Request,
    manifest: &Manifest,
    output: &Path,
    deadline: Instant,
) -> io::Result<()> {
    directory(Path::new(PROMOTIONS), 0o700, 0, 0, false)?;
    directory(Path::new(WORKSPACE), 0o711, 0, 0, false)?;
    let pending = Path::new(PROMOTIONS).join(&request.operation_id);
    directory(&pending, 0o700, 0, 0, true)?;
    let source = open_directory(output)?;
    if names(&source)? != [b"acceptance".to_vec(), b"workspace".to_vec()] {
        return Err(invalid());
    }
    let device = source.metadata()?.dev();
    let target = open_directory(&pending)?;
    let mut state = CopyState {
        deadline,
        count: 0,
        bytes: 0,
        metadata_bytes: 0,
        proof: SourceTreeBuilder::new(),
        expected: manifest
            .files
            .iter()
            .map(|file| (file.path.as_str(), (file.sha256.as_str(), file.bytes)))
            .collect(),
        seen: BTreeSet::new(),
    };
    for (part, acceptance) in [
        (b"workspace".as_slice(), false),
        (b"acceptance".as_slice(), true),
    ] {
        let input = child(&source, part, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        inert(&input, device)?;
        let destination = make_dir(&target, part)?;
        state.copy(&input, &destination, b"", acceptance, device)?;
        set_owner_mode(
            &destination,
            if acceptance { 0 } else { 1000 },
            if acceptance { 0 } else { 1000 },
            if acceptance { 0o555 } else { 0o755 },
        )?;
        destination.sync_all()?;
    }
    if state.seen.len() != manifest.files.len() {
        return Err(invalid());
    }
    let proof = state.proof.finish().map_err(|_| invalid())?;
    if proof.source_tree_sha256 != manifest.source_tree_sha256
        || proof.source_file_count != manifest.source_file_count
        || proof.source_bytes != manifest.source_bytes
    {
        return Err(invalid());
    }
    set_owner_mode(&target, 0, 0, 0o711)?;
    target.sync_all()?;
    let from = open_directory(Path::new(PROMOTIONS))?;
    let to = open_directory(Path::new(WORKSPACE))?;
    let operation = name(request.operation_id.as_bytes())?;
    if unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            from.as_raw_fd(),
            operation.as_ptr(),
            to.as_raw_fd(),
            operation.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    from.sync_all()?;
    to.sync_all()
}

fn remove_children(root: &File, device: u64) -> io::Result<()> {
    for entry in names(root)? {
        let probe = child(root, &entry, libc::O_PATH, 0)?;
        let meta = probe.metadata()?;
        if meta.dev() != device || !meta.is_dir() && !meta.is_file() {
            return Err(invalid());
        }
        if meta.is_dir() {
            let folder = child(root, &entry, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            remove_children(&folder, device)?;
        }
        let entry = name(&entry)?;
        if unsafe {
            libc::unlinkat(
                root.as_raw_fd(),
                entry.as_ptr(),
                if meta.is_dir() { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    root.sync_all()
}

/// The parser tree has died and the copy is verified. Remove bulky transport
/// data, retaining only the original immutable Host request outside /workspace.
pub(crate) fn finish_staging(request: &Request) -> io::Result<()> {
    let root = open_directory(&Path::new(IMPORTS).join(&request.operation_id))?;
    let output = child(&root, b"output", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    remove_children(&output, output.metadata()?.dev())?;
    if unsafe { libc::unlinkat(root.as_raw_fd(), c"output".as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let input = child(&root, b"input", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    for entry in names(&input)? {
        if entry == b"request.json" {
            continue;
        }
        let entry = name(&entry)?;
        if unsafe { libc::unlinkat(input.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let request_file = child(&input, b"request.json", libc::O_RDONLY, 0)?;
    set_owner_mode(&request_file, 0, 0, 0o400)?;
    request_file.sync_all()?;
    set_owner_mode(&input, 0, 0, 0o700)?;
    input.sync_all()?;
    set_owner_mode(&root, 0, 0, 0o700)?;
    root.sync_all()
}

pub(crate) fn store_receipt(
    request: &Request,
    receipt: &crate::protocol::Receipt,
) -> io::Result<()> {
    directory(Path::new(RECEIPTS), 0o700, 0, 0, false)?;
    let root = open_directory(Path::new(RECEIPTS))?;
    let mut file = child(
        &root,
        format!("{}.json", request.operation_id).as_bytes(),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    crate::protocol::write_json(&mut file, receipt, crate::protocol::RECEIPT_LIMIT)?;
    file.sync_all()?;
    root.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("cognia-promotion-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("source")).unwrap();
            fs::create_dir(root.join("target")).unwrap();
            Self(root)
        }
        fn refuses(&self, acceptance: bool) {
            let source = open_directory(&self.0.join("source")).unwrap();
            let target = open_directory(&self.0.join("target")).unwrap();
            let mut state = CopyState {
                deadline: Instant::now() + std::time::Duration::from_secs(1),
                count: 0,
                bytes: 0,
                metadata_bytes: 0,
                proof: SourceTreeBuilder::new(),
                expected: BTreeMap::new(),
                seen: BTreeSet::new(),
            };
            assert!(state
                .copy(
                    &source,
                    &target,
                    b"",
                    acceptance,
                    source.metadata().unwrap().dev()
                )
                .is_err());
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn copier_refuses_symlinks_hardlinks_and_special_files_before_reading() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink("/etc/passwd", fixture.0.join("source/link")).unwrap();
        fixture.refuses(false);
        let fixture = Fixture::new();
        fs::write(fixture.0.join("original"), b"data").unwrap();
        fs::hard_link(
            fixture.0.join("original"),
            fixture.0.join("source/hardlink"),
        )
        .unwrap();
        fixture.refuses(false);
        let fixture = Fixture::new();
        use std::os::unix::ffi::OsStrExt;
        let fifo = CString::new(fixture.0.join("source/fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        fixture.refuses(false);
    }
    #[test]
    fn acceptance_copy_refuses_unlisted_content_and_privileged_modes() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("source/extra"), b"unexpected").unwrap();
        fixture.refuses(true);
        let fixture = Fixture::new();
        fs::write(fixture.0.join("source/setuid"), b"data").unwrap();
        fs::set_permissions(
            fixture.0.join("source/setuid"),
            fs::Permissions::from_mode(0o4755),
        )
        .unwrap();
        fixture.refuses(false);
    }
    #[test]
    fn child_names_never_cross_a_pinned_directory() {
        for value in [b"..".as_slice(), b"a/b", b"", b".", b"nul\0name"] {
            assert!(name(value).is_err());
        }
        assert!(name(b"valid\xffname").is_ok());
    }
    #[test]
    fn authority_roots_are_outside_shared_workspace() {
        for root in [IMPORTS, PROMOTIONS, RECEIPTS] {
            assert!(!Path::new(root).starts_with(WORKSPACE));
        }
    }
}
