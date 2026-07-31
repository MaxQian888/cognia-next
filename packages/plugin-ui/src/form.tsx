import * as React from "react"
import type { Label as LabelPrimitive } from "radix-ui"
import { Slot } from "radix-ui"
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"

import { cn } from "./cn"
import { Label } from "./label"

/**
 * Form context provider — `react-hook-form`'s `FormProvider` under this name.
 *
 * The kit deliberately owns only the *wiring* (ids, `aria-describedby`,
 * `aria-invalid`, error text) and never the form state: a plugin brings its own
 * `useForm()` and its own resolver, so validation rules and their messages stay
 * in the plugin's language and locale. Spread the `useForm()` return into this
 * provider, then build fields from `FormField` → `FormItem` → `FormLabel` /
 * `FormControl` / `FormDescription` / `FormMessage`.
 */
const Form = FormProvider

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = { name: TName }

const FormFieldContext = React.createContext<FormFieldContextValue | undefined>(undefined)
const FormItemContext = React.createContext<{ id: string } | undefined>(undefined)

/**
 * Binds one field name to the surrounding form. Publishes that name on context
 * so `FormLabel` / `FormControl` / `FormMessage` can find the field's state
 * without being handed it — which is what keeps a field's markup free of prop
 * threading.
 */
function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

/**
 * The current field's id triplet plus its `react-hook-form` state, for building
 * a control the kit does not ship.
 *
 * Throws outside `<FormField>` / `<FormItem>` instead of degrading: the ids it
 * returns are what wire a label to its input and an error to `aria-describedby`,
 * so a silent fallback would produce a field that looks right and is unusable
 * with a screen reader.
 */
function useFormField() {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  if (!fieldContext || !itemContext) {
    throw new Error("useFormField must be used within <FormField> and <FormItem>")
  }
  const { getFieldState } = useFormContext()
  const formState = useFormState({ name: fieldContext.name })
  const fieldState = getFieldState(fieldContext.name, formState)

  return {
    id: itemContext.id,
    name: fieldContext.name,
    formItemId: `${itemContext.id}-form-item`,
    formDescriptionId: `${itemContext.id}-form-item-description`,
    formMessageId: `${itemContext.id}-form-item-message`,
    ...fieldState,
  }
}

/**
 * One field's layout row. Mints the `useId()` the label/control/description/
 * message ids are all derived from, so a field can appear any number of times
 * on a page without colliding.
 */
function FormItem({ className, ...props }: React.ComponentProps<"div">) {
  const id = React.useId()
  return (
    <FormItemContext.Provider value={{ id }}>
      <div data-slot="form-item" className={cn("grid gap-2", className)} {...props} />
    </FormItemContext.Provider>
  )
}

/** Label bound to the field's control by id, tinted destructive while invalid. */
function FormLabel({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const { error, formItemId } = useFormField()
  return (
    <Label
      data-slot="form-label"
      data-error={Boolean(error)}
      className={cn("data-[error=true]:text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    />
  )
}

/**
 * Slots the accessibility wiring onto whatever single child it is given — an
 * `Input`, a `Select` trigger, a plugin's own control. It renders no element of
 * its own, so the child must forward `id` / `aria-*` to its DOM node.
 */
function FormControl(props: React.ComponentProps<typeof Slot.Root>) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField()
  return (
    <Slot.Root
      data-slot="form-control"
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={Boolean(error)}
      {...props}
    />
  )
}

/** Persistent helper text; always in the control's `aria-describedby`. */
function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
  const { formDescriptionId } = useFormField()
  return (
    <p
      data-slot="form-description"
      id={formDescriptionId}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * Renders the field's validation message, or `children` as a hint when the
 * field is valid. Returns `null` when there is neither, so a field with no
 * error contributes no empty paragraph to the grid's row rhythm.
 *
 * The message text comes from the plugin's own resolver — this package never
 * supplies wording.
 */
function FormMessage({ className, children, ...props }: React.ComponentProps<"p">) {
  const { error, formMessageId } = useFormField()
  const body = error ? String(error.message ?? "") : children
  if (!body) return null
  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      className={cn("text-sm text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  )
}

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
}
