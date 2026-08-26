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
  if (error instanceof DomainError) return error
  if (error instanceof ProviderError) {
    const code = error.kind === "limit"
      ? "provider_limit"
      : error.kind === "ambiguous_execution"
        ? "ambiguous_execution"
        : "provider_failure"
    return new DomainError(code, error.message, { cause: error })
  }
  return new DomainError("provider_failure", "The provider operation failed", { cause: error })
}

export function errorRecord(error: DomainError): ResourceErrorRecord {
  return { code: error.code, message: error.message }
}
