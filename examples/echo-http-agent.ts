// The smallest http agent: it reads the task and answers with a summary.
// Run it with ECHO_TOKEN=secret node examples/echo-http-agent.ts, then
// ECHO_TOKEN=secret npx bugmole-agent-kit verify http://127.0.0.1:8080 --credential-env ECHO_TOKEN
import { defineHttpAgent, serveNode } from "../src/server.ts";
import type { AgentManifest } from "../src/protocol.ts";

export const manifest: AgentManifest = {
  schemaVersion: 1,
  id: "echo",
  name: "Echo",
  description: "Answers every task with a summary of what it was asked. For trying the protocol.",
  publisher: { name: "Bugmole" },
  protocol: "http",
  endpoint: "http://127.0.0.1:8080",
  credential: { label: "Echo token" },
  capabilities: {},
};

export const echoAgent = (token: string) => defineHttpAgent({
  manifest,
  authorize: (sent) => sent === token,
  async run(request, context) {
    context.progress("Reading the task");
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { summary: `Received "${request.task.title}" (${request.task.type}).` };
  },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await serveNode(echoAgent(process.env.ECHO_TOKEN ?? "secret"), Number(process.env.PORT ?? 8080));
  console.log(`Echo agent on ${server.url}`);
}
