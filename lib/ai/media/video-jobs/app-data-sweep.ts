/**
 * Retention for the video files under AppData (ADR-0205), run by the storage
 * retention sweep beside `pruneSettledVideoJobs`.
 *
 * The row prune removes a workflow job's file with its row. This removes what
 * no row accounts for:
 *
 * - the directory of every database that no longer exists (account deletion or
 *   "clear all data" whose own removal failed, a removed runtime target);
 * - a generated video in the active database's directory whose job has no row
 *   (the database was cleared and recreated under the same name, or a removal
 *   failed after its row went). A file is matched to its job by name
 *   (`<jobId>.<ext>`, or the `<jobId>.<ext>.<id>.part` of a write in flight),
 *   so a job that is still downloading keeps its file;
 * - a composer staging copy older than {@link STALE_STAGING_MS}: a copy lives
 *   for one preparation, so an old one was left by a crash.
 */

import Dexie from "dexie"

import { existingVideoJobIds } from "@/lib/db/media-generation-jobs"
import {
  COMPOSER_VIDEO_STAGING_APP_DATA_DIR,
  GENERATED_VIDEO_APP_DATA_DIR,
  activeDatabaseAppDataDir,
  sweepDroppedDatabaseAppData,
} from "@/lib/tauri/account-app-data"
import {
  appDataModifiedAt,
  listAppDataDirectory,
  removeAppDataFile,
} from "@/lib/tauri/app-data-files"
import { detectHostProfile } from "@/lib/platform/capabilities"

/** Age past which a staging copy is a crash's leftover, not a preparation's. */
export const STALE_STAGING_MS = 24 * 60 * 60 * 1000

export interface VideoAppDataSweepDeps {
  now(): number
  databaseExists(databaseName: string): Promise<boolean>
  existingJobIds(ids: readonly string[]): Promise<Set<string>>
}

const defaultDeps: VideoAppDataSweepDeps = {
  now: () => Date.now(),
  databaseExists: (databaseName) => Dexie.exists(databaseName),
  existingJobIds: existingVideoJobIds,
}

export interface VideoAppDataSweepResult {
  databaseDirectories: number
  orphanVideos: number
  staleStagingCopies: number
}

/** Remove each path; one that cannot be removed now is left for the next sweep. */
async function removeFiles(paths: readonly string[]): Promise<number> {
  let removed = 0
  for (const path of paths) {
    try {
      await removeAppDataFile(path)
      removed += 1
    } catch {
      // Held open or refused: the next sweep tries again.
    }
  }
  return removed
}

async function orphanVideos(deps: VideoAppDataSweepDeps): Promise<string[]> {
  const dir = activeDatabaseAppDataDir(GENERATED_VIDEO_APP_DATA_DIR)
  const files = (await listAppDataDirectory(dir)).filter((entry) => entry.isFile)
  const jobIdOf = (name: string) => name.split(".")[0]
  const existing = await deps.existingJobIds([...new Set(files.map((f) => jobIdOf(f.name)))])
  return files.filter((f) => !existing.has(jobIdOf(f.name))).map((f) => `${dir}/${f.name}`)
}

async function staleStagingCopies(deps: VideoAppDataSweepDeps): Promise<string[]> {
  const dir = activeDatabaseAppDataDir(COMPOSER_VIDEO_STAGING_APP_DATA_DIR)
  const cutoff = deps.now() - STALE_STAGING_MS
  const stale: string[] = []
  for (const entry of await listAppDataDirectory(dir)) {
    if (!entry.isFile) continue
    const path = `${dir}/${entry.name}`
    const modifiedAt = await appDataModifiedAt(path).catch(() => null)
    if (modifiedAt !== null && modifiedAt < cutoff) stale.push(path)
  }
  return stale
}

/** One sweep. A no-op off the desktop, where these directories do not exist. */
export async function sweepVideoAppData(
  deps: VideoAppDataSweepDeps = defaultDeps
): Promise<VideoAppDataSweepResult> {
  if (detectHostProfile() !== "desktop") {
    return { databaseDirectories: 0, orphanVideos: 0, staleStagingCopies: 0 }
  }
  const databaseDirectories = await sweepDroppedDatabaseAppData(deps.databaseExists)
  return {
    databaseDirectories,
    orphanVideos: await removeFiles(await orphanVideos(deps)),
    staleStagingCopies: await removeFiles(await staleStagingCopies(deps)),
  }
}
