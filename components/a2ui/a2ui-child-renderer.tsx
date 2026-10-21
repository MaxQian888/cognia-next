"use client"

import React, { memo, useContext } from "react"
import { A2UIButton } from "./form/a2ui-button"
import type { A2UIButtonComponent } from "@/types/a2ui/schema"
import { A2UIActionsCtx, A2UIDataCtx } from "@/hooks/a2ui/use-a2ui-context"
import { useA2UIActions } from "@/hooks/a2ui/use-a2ui-context"

/**
 * Render a list of child component IDs.
 *
 * Extracted to its own module to break the circular dependency between
 * a2ui-renderer (which imports every layout component) and layout
 * components (which need A2UIChildRenderer).
 */
export const A2UIChildRenderer = memo(function A2UIChildRenderer({
  childIds,
}: {
  childIds: string[]
}) {
  // Actions-only context: re-renders when the component tree changes, but not
  // on data-model-only changes (e.g. keystrokes)
  const { renderChild } = useA2UIActions()

  return (
    <>
      {childIds.map((childId) => (
        <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
      ))}
    </>
  )
})

/** Forward overlay semantics/ref to a native control across the descriptor renderer. */
export function A2UITrigger({
  componentId,
  renderChild,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  componentId: string
  renderChild: (id: string) => React.ReactNode
  ref?: React.Ref<HTMLElement>
}) {
  const actions = useContext(A2UIActionsCtx)
  const data = useContext(A2UIDataCtx)
  const component = actions?.getComponent(componentId)
  const entry = actions?.catalog?.components[component?.component ?? ""]
  if (component?.visible !== undefined && data && !data.resolveBoolean(component.visible, true))
    return null
  if (
    component?.component === "Button" &&
    actions &&
    data &&
    (!entry || entry.component === A2UIButton)
  ) {
    return (
      <A2UIButton
        component={component as A2UIButtonComponent}
        surfaceId={actions.surfaceId}
        dataModel={data.dataModel}
        onAction={(action, values) => actions.emitAction(action, componentId, values)}
        onDataChange={actions.setDataValue}
        renderChild={renderChild}
        triggerProps={props as React.ComponentPropsWithRef<"button">}
      />
    )
  }
  const child = renderChild(componentId)
  if (React.isValidElement(child) && typeof child.type === "string") {
    return React.cloneElement(child as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
      tabIndex: ["button", "a", "input", "select", "textarea"].includes(child.type) ? undefined : 0,
      ...props,
    })
  }
  return (
    <span tabIndex={0} {...props}>
      {child}
    </span>
  )
}
