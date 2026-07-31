import type { ComponentSpec } from "../../types.js"

/**
 * Extracts shared logic from multiple components
 * Consolidates API calls, utilities, and constants
 */
export class SharedLogicExtractor {
  /**
   * Extract all API-related code from components
   */
  static extractApiLogic(specs: ComponentSpec[]): string {
    const apiCalls = new Map<string, string>()
    const endpoints = new Set<string>()

    // Scan all components for API patterns
    specs.forEach((spec) => {
      if (spec.logic?.methods) {
        spec.logic.methods.forEach((method) => {
          const code = method.code || ""

          // Detect API calls
          if (code.includes("fetch(") || code.includes("axios")) {
            // Extract endpoint if possible
            const endpointMatch = code.match(/(?:fetch|axios)\(['"`]([^'"`]+)['"`]/)
            if (endpointMatch && endpointMatch[1]) {
              const endpoint = endpointMatch[1]
              endpoints.add(endpoint)

              // Extract method name
              const methodMatch = method.name || "apiCall"
              if (!apiCalls.has(methodMatch)) {
                apiCalls.set(methodMatch, endpoint)
              }
            }
          }
        })
      }
    })

    // Generate API file with actual functions
    if (apiCalls.size === 0 && endpoints.size === 0) {
      return this.generateEmptyApiFile()
    }

    return this.generateApiFile(Array.from(apiCalls.entries()), Array.from(endpoints))
  }

  /**
   * Extract utility functions from components
   */
  static extractUtilities(specs: ComponentSpec[]): string {
    const utilities = new Map<string, string>()
    const patterns = new Set<string>()

    specs.forEach((spec) => {
      if (spec.logic?.methods) {
        spec.logic.methods.forEach((method) => {
          // Detect common utility patterns
          if (method.kind === "utility" || method.code?.includes("function")) {
            if (!utilities.has(method.name)) {
              utilities.set(method.name, method.code || "")
              patterns.add(method.kind || "utility")
            }
          }

          // Detect formatting functions
          if (method.code?.includes("format") || method.code?.includes("parse")) {
            if (!utilities.has(method.name)) {
              utilities.set(method.name, method.code || "")
              patterns.add("formatter")
            }
          }
        })
      }
    })

    if (utilities.size === 0) {
      return this.generateEmptyUtilsFile()
    }

    return this.generateUtilsFile(Array.from(utilities.entries()))
  }

  /**
   * Extract constants from components
   */
  static extractConstants(specs: ComponentSpec[]): string {
    const constants = new Map<string, string>()

    specs.forEach((spec) => {
      // Extract from component data
      if (spec.logic?.state) {
        spec.logic.state.forEach((state) => {
          if (typeof state.initial === "string" && state.initial.length > 0) {
            // Potential constant
            const constantName = `DEFAULT_${state.name.toUpperCase()}`
            if (!constants.has(constantName)) {
              constants.set(constantName, JSON.stringify(state.initial))
            }
          }
        })
      }

      // Extract from methods
      if (spec.logic?.methods) {
        spec.logic.methods.forEach((method) => {
          const code = method.code || ""

          // Find URL-like strings that look like API endpoints or configuration
          const urlMatches = code.match(/['"`](https?:\/\/[^'"`]+)['"`]/g) || []
          urlMatches.forEach((match) => {
            const url = match.slice(1, -1) // strip quotes
            const name = `API_ENDPOINT_${constants.size + 1}`
            if (!Array.from(constants.values()).includes(url)) {
              constants.set(name, url)
            }
          })
        })
      }
    })

    if (constants.size === 0) {
      return this.generateEmptyConstantsFile()
    }

    return this.generateConstantsFile(Array.from(constants.entries()))
  }

  /**
   * Generate actual API file with functions
   */
  private static generateApiFile(apiCalls: [string, string][], endpoints: string[]): string {
    let code = `// Shared API utilities (using native fetch)
// Auto-generated from component analysis
// Add dependencies as needed (e.g., npm install axios)

const API_BASE = process.env.VITE_API_BASE || process.env.REACT_APP_API_BASE || '/api'

/**
 * Generic fetch wrapper with error handling
 */
async function fetchApi(endpoint: string, options?: RequestInit) {
  const url = \`\${API_BASE}\${endpoint}\`
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    })

    if (!response.ok) {
      throw new Error(\`HTTP \${response.status}: \${response.statusText}\`)
    }

    return await response.json()
  } catch (error) {
    console.error('API Error:', error)
    throw error
  }
}

// API endpoints and methods
`

    if (endpoints.length > 0) {
      code += `\n// Discovered endpoints:\n`
      endpoints.forEach((endpoint: string) => {
        code += `// - ${endpoint}\n`
      })
    }

    code += `\n// API Methods\n`

    if (apiCalls.length > 0) {
      apiCalls.forEach(([name, endpoint]) => {
        const functionName = this.camelCase(name)
        code += `
/**
 * ${name}
 * Endpoint: ${endpoint}
 */
export const ${functionName} = async (params?: Record<string, any>) => {
  const query = params ? '?' + new URLSearchParams(params).toString() : ''
  return fetchApi('${endpoint}' + query)
}
`
      })
    }

    code += `
/**
 * Error handler utility
 */
export const handleApiError = (error: any): string => {
  if (error instanceof TypeError) {
    return 'Network error - please check your connection'
  }
  if (error.message.includes('401')) {
    return 'Authentication required'
  }
  if (error.message.includes('403')) {
    return 'Access forbidden'
  }
  if (error.message.includes('404')) {
    return 'Resource not found'
  }
  return error.message || 'API error'
}
`

    return code
  }

  /**
   * Generate actual utilities file
   */
  private static generateUtilsFile(utilities: [string, string][]): string {
    let code = `// Shared utility functions
// Auto-generated from component analysis

`

    utilities.forEach(([name, impl]) => {
      code += `/**
 * ${name}
 */
export const ${this.camelCase(name)} = () => {
  // TODO: Implement ${name}
  // Original: ${(impl || "").substring(0, 50)}
}

`
    })

    // Add common utilities
    code += `
// Common utility functions
/**
 * Debounce function to limit rapid calls
 */
export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: NodeJS.Timeout | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

/**
 * Throttle function to limit calls over time
 */
export const throttle = <T extends (...args: any[]) => any>(
  func: T,
  limit: number
): ((...args: Parameters<T>) => void) => {
  let lastRun = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastRun >= limit) {
      func(...args);
      lastRun = now;
    }
  };
};

/**
 * Deep clone an object
 */
export const deepClone = <T>(obj: T): T => {
  return JSON.parse(JSON.stringify(obj));
};
`

    return code
  }

  /**
   * Generate constants file
   */
  private static generateConstantsFile(constants: [string, string][]): string {
    let code = `// Shared constants
// Auto-generated from component analysis

`

    constants.forEach(([name, value]) => {
      code += `export const ${name} = ${value}\n`
    })

    code += `
// Default configuration
export const DEFAULT_TIMEOUT = 30000
export const DEFAULT_RETRY_COUNT = 3
export const DEFAULT_PAGE_SIZE = 20

// API configuration
export const API_ENDPOINTS = {
  // Add your API endpoints here
  // Example: USERS: '/api/users',
}

// Application configuration
export const APP_CONFIG = {
  VERSION: '1.0.0',
  ENV: process.env.NODE_ENV || 'development',
  DEBUG: process.env.DEBUG === 'true',
}
`

    return code
  }

  /**
   * Generate empty API file
   */
  private static generateEmptyApiFile(): string {
    return `// Shared API utilities (using native fetch)
// Auto-generated from component analysis
// Add external dependencies as needed (e.g., npm install axios)

const API_BASE = process.env.VITE_API_BASE || process.env.REACT_APP_API_BASE || '/api'

/**
 * Generic fetch wrapper
 */
async function fetchApi(endpoint: string, options?: RequestInit) {
  const url = \`\${API_BASE}\${endpoint}\`
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`)
  return response.json()
}

/**
 * TODO: Add your API methods here
 *
 * Example:
 * export const fetchUsers = async (page = 1) => {
 *   return fetchApi(\`/users?page=\${page}\`)
 * }
 */

// Error handler
export const handleApiError = (error: any): string => {
  if (error instanceof TypeError) {
    return 'Network error'
  }
  return error.message || 'API error'
}
`
  }

  /**
   * Generate empty utils file
   */
  private static generateEmptyUtilsFile(): string {
    return `// Shared utility functions
// Auto-generated from component analysis

/**
 * TODO: Add your utility functions here
 *
 * Examples:
 * export const formatDate = (date: Date) => date.toLocaleDateString()
 * export const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)
 */

// Common utilities
export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: NodeJS.Timeout | null = null
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }
}

export const throttle = <T extends (...args: any[]) => any>(
  func: T,
  limit: number
): ((...args: Parameters<T>) => void) => {
  let lastRun = 0
  return (...args: Parameters<T>) => {
    const now = Date.now()
    if (now - lastRun >= limit) {
      func(...args)
      lastRun = now
    }
  }
}

export const deepClone = <T>(obj: T): T => {
  return JSON.parse(JSON.stringify(obj))
}
`
  }

  /**
   * Generate empty constants file
   */
  private static generateEmptyConstantsFile(): string {
    return `// Shared constants
// Auto-generated from component analysis

// Application version and environment
export const APP_VERSION = '1.0.0'
export const APP_ENV = process.env.NODE_ENV || 'development'

// Default configuration
export const DEFAULT_TIMEOUT = 30000
export const DEFAULT_RETRY_COUNT = 3
export const DEFAULT_PAGE_SIZE = 20

// API configuration
export const API_ENDPOINTS = {
  // TODO: Add your API endpoints
  // USERS: '/api/users',
  // POSTS: '/api/posts',
}

// UI configuration
export const COLORS = {
  PRIMARY: '#007bff',
  SUCCESS: '#28a745',
  DANGER: '#dc3545',
  WARNING: '#ffc107',
  INFO: '#17a2b8',
}

export const SIZES = {
  SM: '8px',
  MD: '16px',
  LG: '24px',
  XL: '32px',
}
`
  }

  /**
   * Convert string to camelCase
   */
  private static camelCase(str: string): string {
    return str
      .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
        index === 0 ? word.toLowerCase() : word.toUpperCase()
      )
      .replace(/\s+/g, "")
  }
}
