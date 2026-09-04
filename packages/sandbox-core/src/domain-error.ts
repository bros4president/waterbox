import type { ErrorCode } from "@waterbox/contracts"

export class DomainError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DomainError"
    this.code = code
  }
}

export function publicMessage(code: ErrorCode): string {
  switch (code) {
    case "not_found": return "The resource was not found"
    case "conflict": return "The request conflicts with current state"
    case "provider_configuration_mismatch": return "The resource belongs to a different provider configuration"
    case "idempotency_conflict": return "The idempotency key conflicts with an earlier request"
    case "idempotency_in_progress": return "The idempotent request is still in progress"
    case "invalid_state": return "The resource is not in a valid state for this operation"
    case "unsupported_capability": return "The requested capability is not supported"
    case "provider_limit": return "The provider limit was reached"
    case "provider_failure": return "The provider operation failed"
    case "ambiguous_execution": return "The provider execution outcome is unknown"
    case "transfer_expired": return "The secure file transfer expired"
    case "transfer_consumed": return "The secure file transfer was already consumed"
    case "invalid_request": return "The request is invalid"
    case "unauthorized": return "Authentication failed"
    case "internal_error": return "An internal error occurred"
  }
}
