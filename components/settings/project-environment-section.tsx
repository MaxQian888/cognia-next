"use client"

/**
 * One chapter of the project environment editor.
 *
 * The editor used to be a bordered box holding bordered boxes: the repository
 * card, the provisioning card, the bootstrap card with a bordered fieldset
 * inside it, one bordered box per action, the runtime card with a bordered
 * ports box, and two more bordered boxes for the trace and the declaration.
 * Four levels of frame for one form, each with its own padding, so a 448px
 * sheet lost a third of its width to nested gutters.
 *
 * Every part of it describes the same workspace's environment, which is the
 * case the console's frameless `sheet` variant exists for: a heading over a
 * hairline rule, the content on the pane's own ground. Using
 * `ConsoleSection` rather than a fourth hand-built header keeps these
 * chapters identical to the device record's, and its `environment-pane`
 * container is what the inner grids size off, so a two-column field row
 * follows the width the editor actually has (a sheet or a full page), not the
 * monitor's.
 */

import type { ComponentProps } from "react"

import { ConsoleSection } from "@/components/surface/console-section"

export type ProjectEnvironmentSectionProps = Omit<
  ComponentProps<typeof ConsoleSection>,
  "pane" | "variant" | "idPrefix"
>

/** The DOM id a section carries, for tests and in-page links. */
export function projectEnvironmentSectionId(id: string): string {
  return `project-environment-section-${id}`
}

export function ProjectEnvironmentSection(props: ProjectEnvironmentSectionProps) {
  return (
    <ConsoleSection
      {...props}
      pane="environment-pane"
      variant="sheet"
      idPrefix="project-environment-section"
    />
  )
}
