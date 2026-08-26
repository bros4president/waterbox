import { Plugin } from "@opencode-ai/plugin"
import { SandboxManager, type PluginOptions } from "./sandbox-manager.ts"
import { registerTools } from "./tools.ts"

export default Plugin.define({
  id: "oc-remote",
  setup: async (context) => {
    const manager = new SandboxManager(context.options as PluginOptions)
    await registerTools(context.tool, manager)
  },
})
