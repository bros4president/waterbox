import { configStorage, credentialState, credentialVariable, loadPersisted, logout, nativeCredentialStore, OnboardingError, setup, type ConfigStorage, type CredentialStore, type SetupPrompts } from "./onboarding.ts"
import { McpConfigurationError, parseMcpConfig } from "./config.ts"

export interface CliDependencies { storage?: ConfigStorage; credentials?: CredentialStore; prompts?: SetupPrompts; environment?: Record<string, string | undefined>; interactive?: boolean; write?: (line: string) => void; error?: (line: string) => void }
const standardPrompts: SetupPrompts = {
  async selectProvider() { const { select } = await import("@inquirer/prompts"); return select({ message: "Provider", choices: [{ name: "Box", value: "box" }, { name: "Vercel", value: "vercel" }] }) },
  async input(message, initial) { const { input } = await import("@inquirer/prompts"); return input({ message, default: initial }) },
  async secret(message) { const { password } = await import("@inquirer/prompts"); return password({ message, mask: "*" }) },
  async confirm(message) { const { confirm } = await import("@inquirer/prompts"); return confirm({ message, default: false }) },
}

export async function runCli(arguments_: string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? (line => console.log(line)), error = dependencies.error ?? (line => console.error(line))
  const storage = dependencies.storage ?? configStorage(), credentials = dependencies.credentials ?? nativeCredentialStore()
  if (arguments_.length !== 1 || !["setup", "status", "logout"].includes(arguments_[0] ?? "")) { error("Usage: waterbox [setup|status|logout]. Run without arguments to start the MCP server."); return 2 }
  try {
    if (arguments_[0] === "setup") {
      if (!(dependencies.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))) throw new OnboardingError("Waterbox setup requires an interactive terminal. Use environment-only configuration in non-interactive environments.")
      const provider = await setup(storage, credentials, dependencies.prompts ?? standardPrompts); write(`Waterbox ${provider} setup completed. Restart the MCP client.`); return 0
    }
    if (arguments_[0] === "logout") { await logout(storage, credentials); write("Waterbox local configuration and stored credentials removed. Remote resources and local SQLite records were not deleted."); return 0 }
    const environment = dependencies.environment ?? process.env
    if (environment.WATERBOX_PROVIDER === undefined && !providerVariablesPresent(environment)) {
      const config = await loadPersisted(storage)
      if (!config) { write("Waterbox status: not configured. Run npx waterbox@next setup."); return 0 }
      const state = await credentialState(config.provider, credentials)
      if (state === "available") await parseMcpConfig(environment, undefined, { storage, credentials })
      write(`Waterbox status: provider ${config.provider}; local configuration keyring; credential ${state}.${state === "available" ? "" : ` Environment fallback: WATERBOX_PROVIDER=${config.provider} and ${credentialVariable(config.provider)}.`}`)
      if (state !== "available") return 1
      return 0
    }
    const parsed = await parseMcpConfig(environment, undefined, { storage, credentials })
    if (parsed.provider.type !== "local") throw new Error("Waterbox Cloud is not supported. Run npx waterbox@next setup for Box or Vercel.")
    const provider = parsed.provider.configuration.provider.kind
    const source = environment.WATERBOX_PROVIDER === undefined ? "keyring" : "environment"
    const state = source === "keyring" ? await credentialState(provider, credentials) : "available"
    write(`Waterbox status: provider ${provider}; configuration ${source}; credential ${state}.`)
    return 0
  } catch (caught) { error(caught instanceof OnboardingError || caught instanceof McpConfigurationError ? caught.message : "Waterbox command failed"); return 1 }
}
function providerVariablesPresent(environment: Record<string, string | undefined>): boolean { return ["WATERBOX_AUTO_STOP", "BOX_API_KEY", "BOX_API_BASE_URL", "BOX_POLL_INTERVAL_MS", "BOX_POLL_TIMEOUT_MS", "VERCEL_TOKEN", "VERCEL_API_ORIGIN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_POLL_INTERVAL_MS", "VERCEL_POLL_TIMEOUT_MS", "VERCEL_REQUEST_TIMEOUT_MS"].some(key => environment[key] !== undefined) }
