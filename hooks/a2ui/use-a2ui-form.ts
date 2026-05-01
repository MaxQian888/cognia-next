"use client"

/**
 * A2UI Form Hook
 * Provides form state management, validation, and submission handling
 */

import { useState, useCallback, useMemo } from "react"

export interface FormField {
  name: string
  value: unknown
  error?: string
  touched?: boolean
  required?: boolean
}

export interface FormState {
  fields: Record<string, FormField>
  isValid: boolean
  isSubmitting: boolean
  isDirty: boolean
  errors: Record<string, string>
}

export interface ValidationRule {
  required?: boolean | string
  minLength?: { value: number; message: string }
  maxLength?: { value: number; message: string }
  pattern?: { value: RegExp; message: string }
  custom?: (value: unknown) => string | undefined
}

export interface UseA2UIFormOptions {
  initialValues?: Record<string, unknown>
  validationRules?: Record<string, ValidationRule>
  onSubmit?: (values: Record<string, unknown>) => void | Promise<void>
}

export function useA2UIForm(options: UseA2UIFormOptions = {}) {
  const { initialValues = {}, validationRules = {}, onSubmit } = options

  const [values, setValues] = useState<Record<string, unknown>>(initialValues)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Validate a single field
  const validateField = useCallback(
    (name: string, value: unknown): string | undefined => {
      const rules = validationRules[name]
      if (!rules) return undefined

      // Required validation
      if (rules.required) {
        const isEmpty = value === undefined || value === null || value === ""
        if (isEmpty) {
          return typeof rules.required === "string" ? rules.required : "This field is required"
        }
      }

      // String validations
      if (typeof value === "string") {
        if (rules.minLength && value.length < rules.minLength.value) {
          return rules.minLength.message
        }
        if (rules.maxLength && value.length > rules.maxLength.value) {
          return rules.maxLength.message
        }
        if (rules.pattern && !rules.pattern.value.test(value)) {
          return rules.pattern.message
        }
      }

      // Custom validation
      if (rules.custom) {
        return rules.custom(value)
      }

      return undefined
    },
    [validationRules]
  )

  // Validate all fields
  const validateAll = useCallback((): Record<string, string> => {
    const newErrors: Record<string, string> = {}
    for (const name of Object.keys(validationRules)) {
      const error = validateField(name, values[name])
      if (error) {
        newErrors[name] = error
      }
    }
    return newErrors
  }, [validateField, validationRules, values])

  // Set a single field value
  const setValue = useCallback(
    (name: string, value: unknown) => {
      setValues((prev) => ({ ...prev, [name]: value }))

      // Validate on change if already touched
      if (touched[name]) {
        const error = validateField(name, value)
        setErrors((prev) => {
          if (error) {
            return { ...prev, [name]: error }
          }
          const { [name]: _, ...rest } = prev
          return rest
        })
      }
    },
    [touched, validateField]
  )

  // Mark field as touched
  const setFieldTouched = useCallback(
    (name: string) => {
      setTouched((prev) => ({ ...prev, [name]: true }))

      // Validate on blur
      const error = validateField(name, values[name])
      setErrors((prev) => {
        if (error) {
          return { ...prev, [name]: error }
        }
        const { [name]: _, ...rest } = prev
        return rest
      })
    },
    [validateField, values]
  )

  // Handle form submission
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) {
        e.preventDefault()
      }

      // Mark all fields as touched
      const allTouched = Object.keys(validationRules).reduce(
        (acc, name) => ({ ...acc, [name]: true }),
        {}
      )
      setTouched(allTouched)

      // Validate all fields
      const newErrors = validateAll()
      setErrors(newErrors)

      // If there are errors, don't submit
      if (Object.keys(newErrors).length > 0) {
        return
      }

      // Submit
      if (onSubmit) {
        setIsSubmitting(true)
        try {
          await onSubmit(values)
        } finally {
          setIsSubmitting(false)
        }
      }
    },
    [validateAll, validationRules, onSubmit, values]
  )

  // Reset form to initial values
  const reset = useCallback(() => {
    setValues(initialValues)
    setErrors({})
    setTouched({})
    setIsSubmitting(false)
  }, [initialValues])

  // Check if form is valid
  const isValid = useMemo(() => {
    const allErrors = validateAll()
    return Object.keys(allErrors).length === 0
  }, [validateAll])

  // Check if form is dirty (any value changed from initial)
  const isDirty = useMemo(() => {
    return Object.keys(values).some((key) => values[key] !== initialValues[key])
  }, [values, initialValues])

  // Get field props helper
  const getFieldProps = useCallback(
    (name: string) => ({
      value: values[name] ?? "",
      error: touched[name] ? errors[name] : undefined,
      onDataChange: (_path: string, value: unknown) => setValue(name, value),
      onBlur: () => setFieldTouched(name),
    }),
    [values, touched, errors, setValue, setFieldTouched]
  )

  return {
    values,
    errors,
    touched,
    isValid,
    isDirty,
    isSubmitting,
    setValue,
    setFieldTouched,
    validateField,
    validateAll,
    handleSubmit,
    reset,
    getFieldProps,
  }
}
