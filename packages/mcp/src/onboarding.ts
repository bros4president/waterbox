import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ProviderConfigurationIdSchema, type ProviderConfigurationId } from "@waterbox/contracts"
import { automaticStopEnvironmentValue, deriveProviderConfigurationId, normalizeBoxApiBaseUrl, normalizeVercelApiOrigin, parseAutomaticStopDuration, providerCredential, type LocalProviderBindingInput } from "@waterbox/control-plane-local"

export type Provider = "box" | "vercel"
export type CredentialState = "available" | "missing" | "inaccessible"
export interface CredentialStore { get(provider: Provider): Promise<string | undefined>; set(provider: Provider, secret: string): Promise<void>; delete(provider: Provider): Promise<boolean> }
export interface ConfigStorage { read(): Promise<string | undefined>; write(value: string): Promise<void>; remove(): Promise<void> }
export interface BoxSettings { apiBaseUrl: string; pollIntervalMs: 1000; pollTimeoutMs: 120000; automaticStopMs?: number }
export interface VercelSettings { apiOrigin: string; teamId: string; projectId: string; pollIntervalMs: 1000; pollTimeoutMs: 120000; requestTimeoutMs: 30000; automaticStopMs?: number }
type PersistedProviderSettings = { provider: "box"; box: BoxSettings } | { provider: "vercel"; vercel: VercelSettings }
type LegacyPersistedConfig = PersistedProviderSettings & { version: 1 }
export type PersistedConfig = LegacyPersistedConfig | (PersistedProviderSettings & { version: 2; providerConfigurationId: ProviderConfigurationId })

export const KEYRING_SERVICE = "waterbox"
const accounts: Record<Provider, string> = { box: "box-api-key", vercel: "vercel-token" }
const MAX_CONFIG_BYTES = 64 * 1024
export const setupGuidance = "Waterbox MCP is not configured. Run waterbox setup, then restart the MCP client. Environment-only setup is also supported: set WATERBOX_PROVIDER and the selected provider's variables (Box: BOX_API_KEY; Vercel: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID). Do not provide credentials in chat or tool arguments."

export class OnboardingError extends Error {
  constructor(message = setupGuidance) { super(message); this.name = "McpConfigurationError" }
}

export function configStorage(home = homedir()): ConfigStorage {
  const path = join(home, ".waterbox", "config.json")
  return {
    async read() {
      try { const directory = await lstat(dirname(path)); if (directory.isSymbolicLink() || !directory.isDirectory()) throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client."); const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client."); return await readFile(path, "utf8") }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    },
    async write(value) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const directory = await lstat(dirname(path))
      if (directory.isSymbolicLink() || !directory.isDirectory()) throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client.")
      await chmod(dirname(path), 0o700)
      try { const existing = await lstat(path); if (existing.isSymbolicLink() || !existing.isFile()) throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client.") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
      try { await writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temporary, path) } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error }
    },
    async remove() {
      try { const directory = await lstat(dirname(path)); if (directory.isSymbolicLink() || !directory.isDirectory()) throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client."); const existing = await lstat(path); if (existing.isSymbolicLink() || !existing.isFile()) throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client."); await rm(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    },
  }
}

export function nativeCredentialStore(): CredentialStore {
  return {
    async get(provider) { const { AsyncEntry } = await import("@napi-rs/keyring"); const value = await new AsyncEntry(KEYRING_SERVICE, accounts[provider]).getPassword(); return value === undefined ? undefined : providerCredential(value) },
    async set(provider, secret) { const accepted = providerCredential(secret); const { AsyncEntry } = await import("@napi-rs/keyring"); await new AsyncEntry(KEYRING_SERVICE, accounts[provider]).setPassword(accepted) },
    async delete(provider) { const { AsyncEntry } = await import("@napi-rs/keyring"); return new AsyncEntry(KEYRING_SERVICE, accounts[provider]).deleteCredential() },
  }
}

export async function loadPersisted(storage: ConfigStorage): Promise<PersistedConfig | undefined> {
  let raw: string | undefined
  try { raw = await storage.read() }
  catch (error) {
    if (error instanceof OnboardingError) throw error
    throw new OnboardingError("Waterbox configuration is unavailable. Run waterbox setup, then restart the MCP client.")
  }
  if (raw === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new OnboardingError("Waterbox configuration is malformed. Run waterbox setup, then restart the MCP client.") }
  const parsed = persistedSchema.safeParse(value)
  if (!parsed.success) throw new OnboardingError("Waterbox configuration is malformed. Run waterbox setup, then restart the MCP client.")
  return parsed.data
}

export async function resolvedEnvironment(environment: Record<string, string | undefined>, storage: ConfigStorage, credentials: CredentialStore): Promise<{ environment: Record<string, string | undefined>; source: "environment" | "keyring"; provider: Provider }> {
  const explicit = environment.WATERBOX_PROVIDER
  if (explicit !== undefined) {
    if (explicit !== "box" && explicit !== "vercel") throw new OnboardingError("Waterbox provider is unsupported. Run waterbox setup, then restart the MCP client.")
    return { environment, source: "environment", provider: explicit }
  }
  if (providerVariablesPresent(environment)) throw new OnboardingError("Set WATERBOX_PROVIDER explicitly when using provider environment variables, or run waterbox setup, then restart the MCP client.")
  const config = await loadPersisted(storage)
  if (!config) throw new OnboardingError()
  let storedSecret: string | undefined
  try { storedSecret = await credentials.get(config.provider) } catch { throw new OnboardingError(`Waterbox credential storage is unavailable. Run waterbox setup or set WATERBOX_PROVIDER=${config.provider} and ${credentialVariable(config.provider)}, then restart the MCP client.`) }
  if (storedSecret === undefined) throw new OnboardingError(`Waterbox credential is missing. Run waterbox setup or set WATERBOX_PROVIDER=${config.provider} and ${credentialVariable(config.provider)}, then restart the MCP client.`)
  let secret: string
  try { secret = providerCredential(storedSecret) } catch { throw new OnboardingError(`Waterbox stored credential is invalid. Run waterbox setup or set WATERBOX_PROVIDER=${config.provider} and ${credentialVariable(config.provider)}, then restart the MCP client.`) }
  const resolved: Record<string, string | undefined> = { ...environment, WATERBOX_PROVIDER: config.provider }
  if (config.provider === "box") { const settings = config.box!; Object.assign(resolved, { BOX_API_KEY: secret, BOX_API_BASE_URL: settings.apiBaseUrl, BOX_POLL_INTERVAL_MS: String(settings.pollIntervalMs), BOX_POLL_TIMEOUT_MS: String(settings.pollTimeoutMs), ...(settings.automaticStopMs === undefined ? {} : { WATERBOX_AUTO_STOP: automaticStopEnvironmentValue(settings.automaticStopMs) }) }) }
  else { const settings = config.vercel!; Object.assign(resolved, { VERCEL_TOKEN: secret, VERCEL_API_ORIGIN: settings.apiOrigin, VERCEL_TEAM_ID: settings.teamId, VERCEL_PROJECT_ID: settings.projectId, VERCEL_POLL_INTERVAL_MS: String(settings.pollIntervalMs), VERCEL_POLL_TIMEOUT_MS: String(settings.pollTimeoutMs), VERCEL_REQUEST_TIMEOUT_MS: String(settings.requestTimeoutMs), ...(settings.automaticStopMs === undefined ? {} : { WATERBOX_AUTO_STOP: automaticStopEnvironmentValue(settings.automaticStopMs) }) }) }
  return { environment: resolved, source: "keyring", provider: config.provider }
}

export interface SetupPrompts { selectProvider(): Promise<Provider>; input(message: string, initial: string): Promise<string>; secret(message: string): Promise<string>; confirm(message: string): Promise<boolean> }
export const automaticStopGuidance = "Choose a duration long enough for your longest uninterrupted workflow.\nProviders and plans enforce different limits and may reject, clamp, or stop\nearlier than requested. Leave blank to use the provider default. A sandbox can\nbe stopped or permanently deleted earlier."
export async function setup(storage: ConfigStorage, credentials: CredentialStore, prompts: SetupPrompts): Promise<Provider> {
  let priorRaw: string | undefined
  try { priorRaw = await storage.read() } catch { throw new OnboardingError("Waterbox configuration is unavailable. Use environment-only setup instead.") }
  const priorConfig = parsePersistedConfig(priorRaw)
  const provider = await prompts.selectProvider()
  let draft: LegacyPersistedConfig
  try {
    const priorAutomaticStop = priorConfig?.provider === provider
      ? automaticStopEnvironmentValue(provider === "box" ? priorConfig.box!.automaticStopMs : priorConfig.vercel!.automaticStopMs) ?? ""
      : ""
    const automaticStopMs = parseAutomaticStopDuration(await prompts.input(`Automatic stop duration (optional, for example 30m or 2h)\n${automaticStopGuidance}`, priorAutomaticStop), { allowBlank: true })
    draft = provider === "box"
      ? { version: 1, provider, box: { apiBaseUrl: normalizeBoxApiBaseUrl(await prompts.input("Box API base URL", priorConfig?.provider === "box" ? priorConfig.box!.apiBaseUrl : "https://ascii.dev/api/box/v1")), pollIntervalMs: 1000, pollTimeoutMs: 120000, ...(automaticStopMs === undefined ? {} : { automaticStopMs }) } }
      : { version: 1, provider, vercel: { apiOrigin: normalizeVercelApiOrigin(await prompts.input("Vercel API origin", priorConfig?.provider === "vercel" ? priorConfig.vercel!.apiOrigin : "https://api.vercel.com/")), teamId: await prompts.input("Vercel team ID", priorConfig?.provider === "vercel" ? priorConfig.vercel!.teamId : ""), projectId: await prompts.input("Vercel project ID", priorConfig?.provider === "vercel" ? priorConfig.vercel!.projectId : ""), pollIntervalMs: 1000, pollTimeoutMs: 120000, requestTimeoutMs: 30000, ...(automaticStopMs === undefined ? {} : { automaticStopMs }) } }
  } catch { throw new OnboardingError("Waterbox setup values are invalid. No configuration was saved.") }
  if (!legacyPersistedSchema.safeParse(draft).success) throw new OnboardingError("Waterbox setup values are invalid. No configuration was saved.")
  let secret: string
  try { secret = providerCredential(await prompts.secret(provider === "box" ? "Box API key" : "Vercel token")) }
  catch { throw new OnboardingError("Waterbox credential is invalid. No configuration was saved.") }
  let prior: Record<Provider, string | undefined>
  try { prior = { box: await credentials.get("box") ?? undefined, vercel: await credentials.get("vercel") ?? undefined } }
  catch { throw new OnboardingError("Waterbox credential storage is unavailable. Use environment-only setup instead.") }
  const prospectiveBinding = bindingFor(draft, secret)
  const config: PersistedConfig = { ...draft, version: 2, providerConfigurationId: prospectiveBinding }
  const currentBinding = priorConfig === undefined ? undefined : persistedBinding(priorConfig, prior[priorConfig.provider])
  if (priorConfig !== undefined && (currentBinding === undefined || prospectiveBinding !== currentBinding)) {
    const confirmed = await prompts.confirm("Changing provider resource scope will not stop, delete, or migrate existing resources. They may continue incurring provider charges. Continue?")
    if (!confirmed) throw new OnboardingError("Waterbox setup was canceled. No local configuration or stored credentials were changed.")
  }
  let selectedMutated = false, configWriteAttempted = false
  try {
    selectedMutated = true
    await credentials.set(provider, secret)
    if (await credentials.get(provider) !== secret) throw new Error("credential unavailable")
    configWriteAttempted = true
    await storage.write(JSON.stringify(config))
  } catch {
    const restoredCredentials = selectedMutated ? await restore(credentials, prior) : true
    const restoredConfig = configWriteAttempted ? await restoreRawConfig(storage, priorRaw) : true
    const restored = restoredCredentials && restoredConfig
    throw new OnboardingError(`Waterbox setup could not complete${restored ? "; rollback was confirmed" : "; rollback could not be confirmed"}. Use ${provider === "box" ? "BOX_API_KEY" : "VERCEL_TOKEN"} with WATERBOX_PROVIDER for environment-only setup.`)
  }
  return provider
}

export async function credentialState(provider: Provider, credentials: CredentialStore): Promise<CredentialState> { try { const value = await credentials.get(provider); if (value === undefined) return "missing"; providerCredential(value); return "available" } catch { return "inaccessible" } }
export async function logout(storage: ConfigStorage, credentials: CredentialStore): Promise<void> {
  const results = await Promise.allSettled([credentials.delete("box"), credentials.delete("vercel")])
  if (results.some(result => result.status === "rejected")) throw new OnboardingError("Waterbox credentials could not be removed; configuration was retained.")
  try { await storage.remove() } catch { throw new OnboardingError("Waterbox credentials were removed, but configuration could not be removed.") }
}

function providerVariablesPresent(environment: Record<string, string | undefined>): boolean { return ["WATERBOX_AUTO_STOP", "BOX_API_KEY", "BOX_API_BASE_URL", "BOX_POLL_INTERVAL_MS", "BOX_POLL_TIMEOUT_MS", "VERCEL_TOKEN", "VERCEL_API_ORIGIN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_POLL_INTERVAL_MS", "VERCEL_POLL_TIMEOUT_MS", "VERCEL_REQUEST_TIMEOUT_MS"].some(key => environment[key] !== undefined) }
export function credentialVariable(provider: Provider): string { return provider === "box" ? "BOX_API_KEY" : "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID" }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 16_384 }
const automaticStopSchema = z.number().int().positive().safe().refine(value => value % 60_000 === 0)
const legacyPersistedSchema: z.ZodType<LegacyPersistedConfig> = z.discriminatedUnion("provider", [
  z.object({ version: z.literal(1), provider: z.literal("box"), box: z.object({ apiBaseUrl: endpointSchema(normalizeBoxApiBaseUrl), pollIntervalMs: z.literal(1000), pollTimeoutMs: z.literal(120000), automaticStopMs: automaticStopSchema.optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), provider: z.literal("vercel"), vercel: z.object({ apiOrigin: endpointSchema(normalizeVercelApiOrigin), teamId: z.string().trim().min(1).max(16_384), projectId: z.string().trim().min(1).max(16_384), pollIntervalMs: z.literal(1000), pollTimeoutMs: z.literal(120000), requestTimeoutMs: z.literal(30000), automaticStopMs: automaticStopSchema.optional() }).strict() }).strict(),
])
const persistedV2Schema = z.discriminatedUnion("provider", [
  z.object({ version: z.literal(2), provider: z.literal("box"), providerConfigurationId: ProviderConfigurationIdSchema, box: z.object({ apiBaseUrl: endpointSchema(normalizeBoxApiBaseUrl), pollIntervalMs: z.literal(1000), pollTimeoutMs: z.literal(120000), automaticStopMs: automaticStopSchema.optional() }).strict() }).strict(),
  z.object({ version: z.literal(2), provider: z.literal("vercel"), providerConfigurationId: ProviderConfigurationIdSchema, vercel: z.object({ apiOrigin: endpointSchema(normalizeVercelApiOrigin), teamId: z.string().trim().min(1).max(16_384), projectId: z.string().trim().min(1).max(16_384), pollIntervalMs: z.literal(1000), pollTimeoutMs: z.literal(120000), requestTimeoutMs: z.literal(30000), automaticStopMs: automaticStopSchema.optional() }).strict() }).strict(),
])
const persistedSchema: z.ZodType<PersistedConfig> = z.union([legacyPersistedSchema, persistedV2Schema]) as z.ZodType<PersistedConfig>
function endpointSchema(normalize: (value: string) => string): z.ZodType<string> { return z.string().trim().min(1).max(16_384).refine(value => { try { normalize(value); return true } catch { return false } }) }
function parsePersistedConfig(raw: string | undefined): PersistedConfig | undefined {
  if (raw === undefined) return undefined
  try { const parsed = persistedSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : undefined } catch { return undefined }
}
function bindingFor(config: PersistedConfig, secret: string): string {
  const selection: LocalProviderBindingInput = config.provider === "box"
    ? { kind: "box", config: { apiBaseUrl: config.box!.apiBaseUrl, apiKey: secret, polling: { intervalMs: config.box!.pollIntervalMs, timeoutMs: config.box!.pollTimeoutMs }, ...(config.box!.automaticStopMs === undefined ? {} : { automaticStopMs: config.box!.automaticStopMs }) } }
    : { kind: "vercel", config: { apiOrigin: config.vercel!.apiOrigin, token: secret, teamId: config.vercel!.teamId, projectId: config.vercel!.projectId, polling: { intervalMs: config.vercel!.pollIntervalMs, timeoutMs: config.vercel!.pollTimeoutMs, requestTimeoutMs: config.vercel!.requestTimeoutMs }, ...(config.vercel!.automaticStopMs === undefined ? {} : { automaticStopMs: config.vercel!.automaticStopMs }) } }
  return deriveProviderConfigurationId(selection)
}
function persistedBinding(config: PersistedConfig, secret: string | undefined): string | undefined {
  if (config.version === 2) return config.providerConfigurationId
  if (config.provider === "vercel") return bindingFor(config, "credential-excluded-from-vercel-binding")
  if (secret === undefined) return undefined
  try { return bindingFor(config, providerCredential(secret)) } catch { return undefined }
}
async function restore(credentials: CredentialStore, prior: Record<Provider, string | undefined>): Promise<boolean> {
  const results = await Promise.allSettled((Object.keys(prior) as Provider[]).map(async provider => prior[provider] === undefined ? credentials.delete(provider) : credentials.set(provider, prior[provider]!)))
  return results.every(result => result.status === "fulfilled")
}
async function restoreRawConfig(storage: ConfigStorage, raw: string | undefined): Promise<boolean> { try { if (raw === undefined) await storage.remove(); else await storage.write(raw); return true } catch { return false } }
