"use client"

import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"

import {
  VIDEO_JOB_ERROR_KEYS,
  VideoJobView,
  videoJobErrorDetail,
} from "@/components/chat/video-generation/video-job-view"
import type { VideoJobErrorCode } from "@/lib/ai/media/video-jobs/types"
import { useParsedOutput } from "./common"

interface VideoGenerateOutput {
  ok?: boolean
  jobId?: string
  code?: string
  error?: string
}

function isJobErrorCode(code: string | undefined): code is VideoJobErrorCode {
  return code !== undefined && Object.prototype.hasOwnProperty.call(VIDEO_JOB_ERROR_KEYS, code)
}

/**
 * `video_generate` result (ADR-0205): the live job card once the job started,
 * or why it did not. A result still streaming in renders nothing, so the
 * generic tool block shows the call until the job id arrives.
 */
export function VideoGenerateCard({ part }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("chat.videoGeneration")
  const output = useParsedOutput<VideoGenerateOutput>(part.output)
  if (!output) return null
  if (output.ok && output.jobId) return <VideoJobView jobId={output.jobId} />
  if (output.ok === false) {
    // A tool-level refusal (no image, bad arguments) has no localized line of
    // its own, so its message is the only detail; a job code has one.
    const detail = isJobErrorCode(output.code)
      ? videoJobErrorDetail({ code: output.code, message: output.error })
      : (output.error ?? null)
    return (
      <div data-testid="video-generate-refused" className="my-1 space-y-1 text-xs" role="alert">
        <p className="font-medium text-destructive">
          {isJobErrorCode(output.code)
            ? t(VIDEO_JOB_ERROR_KEYS[output.code] as never)
            : t("notStarted")}
        </p>
        {detail && <p className="break-words text-muted-foreground">{detail}</p>}
      </div>
    )
  }
  return null
}
