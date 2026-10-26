"use client"

import React, { memo, createContext } from "react"
import { InputGroup, InputGroupAddon, InputGroupText } from "@/components/ui/input-group"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIInputGroupComponent extends A2UIBaseComponent {
  component: "InputGroup"
  children: string[]
  prefix?: string
  suffix?: string
}

export const A2UIInputGroupContext = createContext(false)

export const A2UIInputGroup = memo(function A2UIInputGroup({
  component,
  renderChild,
}: A2UIComponentProps<A2UIInputGroupComponent>) {
  return (
    <A2UIInputGroupContext.Provider value={true}>
      <InputGroup className={component.className} style={component.style as React.CSSProperties}>
        {component.prefix && (
          <InputGroupAddon>
            <InputGroupText>{component.prefix}</InputGroupText>
          </InputGroupAddon>
        )}
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
        {component.suffix && (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{component.suffix}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    </A2UIInputGroupContext.Provider>
  )
})
