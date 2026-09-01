"use client"

/**
 * Browsing files on a machine reached over a saved SSH profile (ADR-0162).
 *
 * A single pane, deliberately. Termius moved its phone client off a fixed
 * two-column layout years ago and Cyberduck never had one: a remote browser
 * plus a separate list of transfers is what survives a narrow screen, and a
 * second pane showing the local filesystem is a pane the shells that most need
 * this do not have.
 *
 * The tree itself is `ProjectFileTree`, unchanged. It took injected
 * dependencies from the start, and it learned to report failures for this
 * backend specifically: over a local workspace a denied listing is rare enough
 * that a swallowed catch survived for years, and over SFTP permission denials,
 * read-only mounts and dropped connections are the ordinary case.
 *
 * What this component does NOT claim is a boundary. `basePath` is where
 * browsing starts, not where it stops. The remote machine resolves its own
 * symlinks and the client can name an absolute path, so an interface promising
 * confinement here would be describing something the wire does not enforce.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderUpIcon, HomeIcon, RefreshCwIcon, UploadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ProjectFileTree } from "@/components/editor/project/project-file-tree"
import type { FileTreeFailure, FileTreeOperation } from "@/lib/files/file-tree-failure"
import {
  createSftpFileTreeDeps,
  joinRemotePath,
  resolveSftpPath,
  statSftpEntry,
} from "@/lib/sftp/client"
import { enqueueSftpDownload, enqueueSftpUpload } from "@/lib/sftp/transfer-queue"
import { SftpTransferTooLargeError } from "@/lib/sftp/transfer-types"
import { cn } from "@/lib/utils"

export interface RemoteFileBrowserProps {
  profileId: string
  profileLabel: string
  /** Where to start. Resolved against the machine when omitted. */
  initialPath?: string
  className?: string
}

const HOME_HINT = "."

export function RemoteFileBrowser({
  profileId,
  profileLabel,
  initialPath,
  className,
}: RemoteFileBrowserProps) {
  const t = useTranslations("sftp.browser")
  const [basePath, setBasePath] = useState(initialPath ?? "")
  const [draftPath, setDraftPath] = useState(initialPath ?? "")
  const [refreshToken, setRefreshToken] = useState(0)
  const [failure, setFailure] = useState<{ failure: FileTreeFailure; path: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const uploadInput = useRef<HTMLInputElement | null>(null)

  const deps = useMemo(() => createSftpFileTreeDeps(profileId), [profileId])

  /**
   * Ask the machine where home is rather than guessing `/home/<user>`.
   *
   * A guess is wrong for root, for macOS, for a chrooted account and for
   * anything with a non-default home, and the failure it produces is an empty
   * directory rather than an error.
   */
  useEffect(() => {
    if (initialPath) return
    let cancelled = false
    void resolveSftpPath(profileId, HOME_HINT)
      .then((resolved) => {
        if (cancelled) return
        setBasePath(resolved)
        setDraftPath(resolved)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Falling back to `/` beats rendering nothing: the root is browsable on
        // every machine this can reach, and the reason home could not be
        // resolved is worth showing rather than swallowing.
        setBasePath("/")
        setDraftPath("/")
        setNotice(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [profileId, initialPath])

  const onFailure = useCallback(
    (next: FileTreeFailure, _operation: FileTreeOperation, relPath: string) => {
      setFailure({ failure: next, path: joinRemotePath(basePath, relPath) })
    },
    [basePath]
  )

  const goTo = useCallback((path: string) => {
    const next = path.trim() || "/"
    setBasePath(next)
    setDraftPath(next)
    setFailure(null)
    setNotice(null)
  }, [])

  const goUp = useCallback(() => {
    const parent = basePath.replace(/\/+$/, "").split("/").slice(0, -1).join("/")
    goTo(parent || "/")
  }, [basePath, goTo])

  /**
   * A click on a file queues a download rather than opening it.
   *
   * There is nowhere to open it: this is somebody else's machine and the file
   * is not on disk here. Queueing is the honest action, and the queue is where
   * its progress and its failures belong.
   */
  const onOpenFile = useCallback(
    (relPath: string) => {
      const remotePath = joinRemotePath(basePath, relPath)
      void statSftpEntry(profileId, remotePath)
        .then((entry) =>
          enqueueSftpDownload({ profileId, profileLabel, remotePath, size: entry.size })
        )
        .then(() => setNotice(t("queuedDownload", { name: relPath })))
        .catch((error: unknown) =>
          setNotice(error instanceof Error ? error.message : String(error))
        )
    },
    [basePath, profileId, profileLabel, t]
  )

  const onPickUpload = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return
      for (const file of Array.from(files)) {
        try {
          await enqueueSftpUpload({
            profileId,
            profileLabel,
            remotePath: joinRemotePath(basePath, file.name),
            body: file,
          })
          setNotice(t("queuedUpload", { name: file.name }))
        } catch (error) {
          setNotice(
            error instanceof SftpTransferTooLargeError
              ? t("tooLarge", { name: file.name })
              : error instanceof Error
                ? error.message
                : String(error)
          )
        }
      }
      setRefreshToken((token) => token + 1)
    },
    [basePath, profileId, profileLabel, t]
  )

  return (
    <div className={cn("space-y-2.5", className)} data-testid="sftp-browser">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="icon" variant="ghost" onClick={goUp} aria-label={t("up")}>
          <FolderUpIcon className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void resolveSftpPath(profileId, HOME_HINT).then(goTo)}
          aria-label={t("home")}
        >
          <HomeIcon className="size-4" aria-hidden />
        </Button>
        <Input
          value={draftPath}
          onChange={(event) => setDraftPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") goTo(draftPath)
          }}
          aria-label={t("pathLabel")}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          data-testid="sftp-path"
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setRefreshToken((token) => token + 1)}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className="size-4" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => uploadInput.current?.click()}
          data-testid="sftp-upload"
        >
          <UploadIcon className="size-3.5" aria-hidden />
          {t("upload")}
        </Button>
        <input
          ref={uploadInput}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            void onPickUpload(event.target.files)
            event.target.value = ""
          }}
        />
      </div>

      {/*
        ADR-0162 refuses to claim a confinement it cannot enforce, and this is
        the surface where a reader would otherwise assume one: a path bar above
        a tree looks exactly like a rooted file browser.
      */}
      <p className="text-[11px] text-muted-foreground">{t("noBoundary")}</p>

      {notice ? (
        <p className="text-[11px] text-muted-foreground" data-testid="sftp-notice">
          {notice}
        </p>
      ) : null}

      {failure ? (
        <p className="text-[11px] text-destructive" data-testid="sftp-failure">
          {t(`failure.${failure.failure.kind}`, { path: failure.path })}
          {failure.failure.detail ? ` ${failure.failure.detail}` : ""}
        </p>
      ) : null}

      {basePath ? (
        <ProjectFileTree
          rootPath={basePath}
          refreshToken={refreshToken}
          activePath={null}
          onOpenFile={onOpenFile}
          deps={deps}
          density="touch"
          onFailure={onFailure}
        />
      ) : null}
    </div>
  )
}
