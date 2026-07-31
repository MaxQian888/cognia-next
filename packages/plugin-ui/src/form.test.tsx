import { render, screen } from "@testing-library/react"
import { useForm } from "react-hook-form"
import { Input } from "./input"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
} from "./form"

function Example() {
  const form = useForm<{ name: string }>({
    defaultValues: { name: "" },
    errors: { name: { type: "required", message: "Name is required" } },
  })
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormDescription>Public display name</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </Form>
  )
}

function HealthyExample() {
  const form = useForm<{ name: string }>({ defaultValues: { name: "Ada" } })
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormDescription>Public display name</FormDescription>
            <FormMessage>Looks good</FormMessage>
            <FormMessage />
          </FormItem>
        )}
      />
    </Form>
  )
}

function InvalidConsumer() {
  useFormField()
  return null
}

describe("Form", () => {
  it("connects labels, descriptions, and validation errors", () => {
    render(<Example />)

    const input = screen.getByRole("textbox", { name: "Name" })
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAccessibleDescription("Public display name Name is required")
    expect(screen.getByText("Name is required")).toHaveAttribute("data-slot", "form-message")
  })

  it("uses child feedback and the description-only relationship without an error", () => {
    render(<HealthyExample />)

    const input = screen.getByRole("textbox", { name: "Name" })
    expect(input).toHaveAttribute("aria-invalid", "false")
    expect(input).toHaveAccessibleDescription("Public display name")
    expect(screen.getByText("Looks good")).toHaveAttribute("data-slot", "form-message")
    expect(document.querySelectorAll('[data-slot="form-message"]')).toHaveLength(1)
  })

  it("rejects consumers outside the field and item providers", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<InvalidConsumer />)).toThrow(
      "useFormField must be used within <FormField> and <FormItem>"
    )
    errorSpy.mockRestore()
  })
})
