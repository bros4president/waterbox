import { ErrorCodeSchema, type ErrorCode, type SandboxId } from "@waterbox/contracts"
import { DomainError, publicMessage } from "./domain-error.ts"
import { ProviderError } from "./provider.ts"
import type { ResourceErrorRecord } from "./records.ts"

export interface PublicDomainErrorDetails { readonly code: ErrorCode; readonly message: string; readonly sandboxId?: SandboxId }

const approved = new WeakMap<DomainError, PublicDomainErrorDetails>()

export function publicDomainError(code: ErrorCode, message: string, options?: ErrorOptions): DomainError {
  const error = new DomainError(code, message, options)
  approved.set(error, Object.freeze({ code, message }))
  return error
}

export function recoveryError(error: DomainError, sandboxId: SandboxId, outcome: "durable_failure" | "uncertain", keyed = false): DomainError {
  const details = domainErrorDetails(error) ?? { code: "internal_error" as const, message: publicMessage("internal_error") }
  const message = outcome === "durable_failure"
    ? keyed
      ? `Sandbox ${sandboxId} has a recorded preparation failure. Inspect it with probe_sandbox; retrying the same creation key returns this failure.`
      : `Sandbox ${sandboxId} has a recorded preparation failure. Inspect it with probe_sandbox before deciding on the next action.`
    : `Sandbox ${sandboxId} may require recovery. Inspect it with probe_sandbox before retrying the operation.`
  const recovery = new DomainError(details.code, message, { cause: error })
  recovery.name = "SandboxRecoveryError"
  approved.set(recovery, Object.freeze({ code: details.code, message, sandboxId }))
  return recovery
}

export function domainErrorDetails(error: unknown): PublicDomainErrorDetails | undefined {
  if (!(error instanceof DomainError)) return undefined
  const trusted = approved.get(error)
  if (trusted !== undefined) return trusted
  const code = ErrorCodeSchema.safeParse(error.code)
  return code.success
    ? { code: code.data, message: publicMessage(code.data) }
    : { code: "internal_error", message: publicMessage("internal_error") }
}

export function mapProviderError(error: unknown, operation: string): DomainError {
  if (error instanceof ProviderError) {
    if (error.kind === "limit") return publicDomainError("provider_limit", `The provider limit was reached while attempting to ${operation}`, { cause: error })
    if (error.kind === "ambiguous_execution") return publicDomainError("ambiguous_execution", `The outcome of the attempt to ${operation} is unknown`, { cause: error })
    if (error.kind === "expired") return publicDomainError("transfer_expired", "The secure file transfer expired", { cause: error })
    if (error.kind === "consumed") return publicDomainError("transfer_consumed", "The secure file transfer was already consumed", { cause: error })
  }
  return publicDomainError("provider_failure", `The provider could not ${operation}`, { cause: error })
}

export function errorRecord(error: DomainError): ResourceErrorRecord {
  const details = domainErrorDetails(error)!
  return { code: details.code, message: details.message }
}
