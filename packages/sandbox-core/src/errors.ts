import type { ErrorCode } from "@waterbox/contracts"
import { ProviderError } from "./provider.ts"
import type { ResourceErrorRecord } from "./records.ts"

export class DomainError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DomainError"
    this.code = code
  }
}

export function mapProviderError(error: unknown): DomainError {
  if (error instanceof ProviderError) {
    if (error.kind === "limit") {
      return new DomainError("provider_limit", "The provider limit was reached")
    }
    if (error.kind === "ambiguous_execution") {
      return new DomainError("ambiguous_execution", "The provider execution outcome is unknown")
    }
    return new DomainError("provider_failure", "The provider operation failed")
  }
  return new DomainError("provider_failure", "The provider operation failed")
}

export function errorRecord(error: DomainError): ResourceErrorRecord {
  return { code: error.code, message: error.message }
}
