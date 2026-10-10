#!/usr/bin/env node
// The smallest cli agent: `node examples/echo-cli-agent.ts run --task task.json`.
import { runAsCliAgent } from "../src/cli-agent.ts";

process.exitCode = await runAsCliAgent({
  credentialEnv: "ECHO_TOKEN",
  async run(request, context) {
    if (!context.credential) throw new Error("ECHO_TOKEN isn't set.");
    context.progress("Reading the task");
    return { summary: `Received "${request.task.title}".`, changedFiles: [] };
  },
});
