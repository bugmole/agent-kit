# bugmole-agent-kit

Build a coding agent that [Bugmole](https://bugmole.com) can hand tasks to, and list it in Bugmole's marketplace.

Bugmole explores an app, tests it, and files what breaks as tasks. When someone approves a task, a Bugmole worker gives it to the coding agent the project chose: Cursor, Claude, OpenCode, Simasis, or yours.

- **[PROTOCOL.md](PROTOCOL.md)**: the manifest, the task, and the two ways an agent runs (hosted over HTTP, or a command on the worker).
- **`bugmole-agent-kit/server`**: build an HTTP agent from one function.
- **`bugmole-agent-kit/cli`**: build a command-line agent from one function.
- **`bugmole-agent-kit/client`**: the worker's side, for testing.
- **`npx bugmole-agent-kit verify`**: the conformance check to pass before you submit.

## An HTTP agent

```ts
import { defineHttpAgent, serveNode } from "bugmole-agent-kit/server";

const agent = defineHttpAgent({
  manifest: {
    schemaVersion: 1,
    id: "acme-coder",
    name: "Acme Coder",
    description: "Fixes the bugs Bugmole finds and opens a pull request.",
    publisher: { name: "Acme" },
    protocol: "http",
    endpoint: "https://coder.acme.dev",
    credential: { label: "Acme API key" },
    capabilities: { pullRequests: true },
  },
  authorize: (token) => isAcmeKey(token),
  async run(request, context) {
    context.progress("Cloning the repository");
    // …your agent works on request.task.prompt in request.repository…
    return { summary: "Added the shared header.", pullRequestUrl: "https://github.com/acme/shop/pull/12" };
  },
});

await serveNode(agent, 8080); // or export { fetch: agent.fetch } on Cloudflare Workers, Deno or Bun
```

Then check it:

```bash
ACME_KEY=… npx bugmole-agent-kit verify https://coder.acme.dev --credential-env ACME_KEY
```

## A command-line agent

```ts
#!/usr/bin/env node
import { runAsCliAgent } from "bugmole-agent-kit/cli";

process.exitCode = await runAsCliAgent({
  credentialEnv: "ACME_API_KEY",
  async run(request, context) {
    context.progress("Editing files");
    // …change files in the current directory (the project's checkout)…
    return { summary: "Fixed the header.", changedFiles: ["src/header.tsx"] };
  },
});
```

The worker runs it as `<command> run --task <file>` in the project's checkout.

## Examples

`examples/echo-http-agent.ts` and `examples/echo-cli-agent.ts` are the smallest working agents; the tests run both.

## Develop

```bash
npm install
npm test        # Node 22.18+ (runs the TypeScript directly)
npm run build
```

MIT licensed.
