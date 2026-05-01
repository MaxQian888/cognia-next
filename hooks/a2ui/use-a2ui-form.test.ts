/**
 * Tests for useA2UIForm hook
 */

import { renderHook, act } from "@testing-library/react"
import { useA2UIForm } from "./use-a2ui-form"

describe("useA2UIForm", () => {
  describe("initialization", () => {
    it("should initialize with default empty values", () => {
      const { result } = renderHook(() => useA2UIForm())

      expect(result.current.values).toEqual({})
      expect(result.current.errors).toEqual({})
      expect(result.current.touched).toEqual({})
      expect(result.current.isValid).toBe(true)
      expect(result.current.isDirty).toBe(false)
      expect(result.current.isSubmitting).toBe(false)
    })

    it("should initialize with provided initial values", () => {
      const initialValues = { name: "John", email: "john@example.com" }
      const { result } = renderHook(() => useA2UIForm({ initialValues }))

      expect(result.current.values).toEqual(initialValues)
      expect(result.current.isDirty).toBe(false)
    })
  })

  describe("setValue", () => {
    it("should update a single field value", () => {
      const { result } = renderHook(() => useA2UIForm())

      act(() => {
        result.current.setValue("name", "John")
      })

      expect(result.current.values.name).toBe("John")
    })

    it("should mark form as dirty when value changes from initial", () => {
      const { result } = renderHook(() => useA2UIForm({ initialValues: { name: "Initial" } }))

      expect(result.current.isDirty).toBe(false)

      act(() => {
        result.current.setValue("name", "Changed")
      })

      expect(result.current.isDirty).toBe(true)
    })

    it("should validate on change if field is touched", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: true },
          },
        })
      )

      // Touch the field first
      act(() => {
        result.current.setFieldTouched("name")
      })

      // Now set an empty value
      act(() => {
        result.current.setValue("name", "")
      })

      expect(result.current.errors.name).toBe("This field is required")
    })
  })

  describe("setFieldTouched", () => {
    it("should mark a field as touched", () => {
      const { result } = renderHook(() => useA2UIForm())

      act(() => {
        result.current.setFieldTouched("name")
      })

      expect(result.current.touched.name).toBe(true)
    })

    it("should validate the field on blur", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            email: { required: "Email is required" },
          },
        })
      )

      act(() => {
        result.current.setFieldTouched("email")
      })

      expect(result.current.errors.email).toBe("Email is required")
    })
  })

  describe("validation", () => {
    it("should validate required fields", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: true },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("name", "")
      })

      expect(error).toBe("This field is required")
    })

    it("should validate required fields with custom message", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: "Please enter your name" },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("name", "")
      })

      expect(error).toBe("Please enter your name")
    })

    it("should validate minLength", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            password: { minLength: { value: 8, message: "Min 8 characters" } },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("password", "short")
      })

      expect(error).toBe("Min 8 characters")
    })

    it("should validate maxLength", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            username: { maxLength: { value: 10, message: "Max 10 characters" } },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("username", "verylongusername")
      })

      expect(error).toBe("Max 10 characters")
    })

    it("should validate pattern", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            email: {
              pattern: {
                value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                message: "Invalid email format",
              },
            },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("email", "invalid-email")
      })

      expect(error).toBe("Invalid email format")
    })

    it("should validate with custom validator", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            age: {
              custom: (value) => {
                const num = Number(value)
                if (isNaN(num) || num < 18) {
                  return "Must be 18 or older"
                }
                return undefined
              },
            },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("age", "15")
      })

      expect(error).toBe("Must be 18 or older")
    })

    it("should pass validation for valid values", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            email: {
              required: true,
              pattern: {
                value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                message: "Invalid email",
              },
            },
          },
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("email", "test@example.com")
      })

      expect(error).toBeUndefined()
    })

    it("should validateAll and return all errors", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: "Name required" },
            email: { required: "Email required" },
          },
        })
      )

      let errors: Record<string, string>
      act(() => {
        errors = result.current.validateAll()
      })

      expect(errors!).toEqual({
        name: "Name required",
        email: "Email required",
      })
    })
  })

  describe("handleSubmit", () => {
    it("should not submit if validation fails", async () => {
      const onSubmit = jest.fn()
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: true },
          },
          onSubmit,
        })
      )

      await act(async () => {
        await result.current.handleSubmit()
      })

      expect(onSubmit).not.toHaveBeenCalled()
      expect(result.current.errors.name).toBe("This field is required")
    })

    it("should submit valid form", async () => {
      const onSubmit = jest.fn()
      const { result } = renderHook(() =>
        useA2UIForm({
          initialValues: { name: "John" },
          validationRules: {
            name: { required: true },
          },
          onSubmit,
        })
      )

      await act(async () => {
        await result.current.handleSubmit()
      })

      expect(onSubmit).toHaveBeenCalledWith({ name: "John" })
    })

    it("should set isSubmitting during submission", async () => {
      let resolveSubmit: () => void
      const submitPromise = new Promise<void>((resolve) => {
        resolveSubmit = resolve
      })

      const onSubmit = jest.fn(() => submitPromise)
      const { result } = renderHook(() =>
        useA2UIForm({
          initialValues: { name: "John" },
          onSubmit,
        })
      )

      let submitPromiseResult: Promise<void>
      act(() => {
        submitPromiseResult = result.current.handleSubmit()
      })

      expect(result.current.isSubmitting).toBe(true)

      await act(async () => {
        resolveSubmit!()
        await submitPromiseResult
      })

      expect(result.current.isSubmitting).toBe(false)
    })

    it("should prevent default on form event", async () => {
      const preventDefault = jest.fn()
      const event = { preventDefault } as unknown as React.FormEvent

      const { result } = renderHook(() => useA2UIForm())

      await act(async () => {
        await result.current.handleSubmit(event)
      })

      expect(preventDefault).toHaveBeenCalled()
    })

    it("should mark all fields as touched on submit", async () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: true },
            email: { required: true },
          },
        })
      )

      await act(async () => {
        await result.current.handleSubmit()
      })

      expect(result.current.touched.name).toBe(true)
      expect(result.current.touched.email).toBe(true)
    })
  })

  describe("reset", () => {
    it("should reset form to initial values", () => {
      const initialValues = { name: "Initial" }
      const { result } = renderHook(() => useA2UIForm({ initialValues }))

      act(() => {
        result.current.setValue("name", "Changed")
        result.current.setFieldTouched("name")
      })

      expect(result.current.values.name).toBe("Changed")
      expect(result.current.touched.name).toBe(true)

      act(() => {
        result.current.reset()
      })

      expect(result.current.values).toEqual(initialValues)
      expect(result.current.errors).toEqual({})
      expect(result.current.touched).toEqual({})
      expect(result.current.isSubmitting).toBe(false)
    })
  })

  describe("isValid", () => {
    it("should return true for valid form", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          initialValues: { name: "John" },
          validationRules: {
            name: { required: true },
          },
        })
      )

      expect(result.current.isValid).toBe(true)
    })

    it("should return false for invalid form", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: true },
          },
        })
      )

      expect(result.current.isValid).toBe(false)
    })
  })

  describe("getFieldProps", () => {
    it("should return field props for a field", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          initialValues: { name: "John" },
        })
      )

      const props = result.current.getFieldProps("name")

      expect(props.value).toBe("John")
      expect(props.error).toBeUndefined()
      expect(typeof props.onDataChange).toBe("function")
      expect(typeof props.onBlur).toBe("function")
    })

    it("should return error only for touched fields", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            name: { required: "Name required" },
          },
        })
      )

      // Not touched - no error shown
      let props = result.current.getFieldProps("name")
      expect(props.error).toBeUndefined()

      // Touch the field
      act(() => {
        result.current.setFieldTouched("name")
      })

      // Now error should be shown
      props = result.current.getFieldProps("name")
      expect(props.error).toBe("Name required")
    })

    it("should update value via onDataChange", () => {
      const { result } = renderHook(() => useA2UIForm())

      const props = result.current.getFieldProps("name")

      act(() => {
        props.onDataChange("name", "New Value")
      })

      expect(result.current.values.name).toBe("New Value")
    })

    it("should touch field via onBlur", () => {
      const { result } = renderHook(() => useA2UIForm())

      const props = result.current.getFieldProps("name")

      act(() => {
        props.onBlur()
      })

      expect(result.current.touched.name).toBe(true)
    })
  })

  describe("edge cases", () => {
    it("should handle null and undefined values for required validation", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {
            field1: { required: true },
            field2: { required: true },
          },
        })
      )

      act(() => {
        result.current.setValue("field1", null)
        result.current.setValue("field2", undefined)
      })

      const errors = result.current.validateAll()

      expect(errors.field1).toBe("This field is required")
      expect(errors.field2).toBe("This field is required")
    })

    it("should skip validation for fields without rules", () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          validationRules: {},
        })
      )

      let error: string | undefined
      act(() => {
        error = result.current.validateField("name", "")
      })

      expect(error).toBeUndefined()
    })

    it("should handle form without onSubmit callback", async () => {
      const { result } = renderHook(() =>
        useA2UIForm({
          initialValues: { name: "John" },
        })
      )

      // Should not throw
      await act(async () => {
        await result.current.handleSubmit()
      })

      expect(result.current.isSubmitting).toBe(false)
    })
  })
})
