// Skills feature: native filesystem sync, registry refresh, GitHub raw
// fetch, and security scan. The frontend's `useSkills`/`useSkillSync` hooks
// call into the commands re-exported from here. All commands return
// `Result<T, String>` so the JS bridge gets a friendly error message.

pub mod bundle;
pub mod install;
pub mod native;
pub mod registry;
pub mod remote;
pub mod scanner;
pub mod types;
