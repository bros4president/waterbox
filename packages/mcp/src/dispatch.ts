import { runCli } from "./cli.ts"
import { main } from "./main.ts"

export async function dispatch(arguments_: string[], dependencies: { main?: () => Promise<void>; cli?: (arguments_: string[]) => Promise<number> } = {}): Promise<number | undefined> {
  if (arguments_.length === 0) { await (dependencies.main ?? main)(); return undefined }
  return (dependencies.cli ?? runCli)(arguments_)
}
