// The conformance check developers run before submitting an agent:
// `bugmole-agent-kit verify https://agent.example.com --credential-env ACME_TOKEN`.
// It reads the manifest, checks a wrong credential is refused, starts a small
// task, follows it to the end, and checks that starting it again doesn't
// start a second run.
import { AgentProtocolError, HttpAgentClient } from "./client.ts";
import type { TaskRequest } from "./protocol.ts";

export type Check = { name: string; ok: boolean; detail?: string };

export async function verifyHttpAgent(endpoint: string, credential: string | null, options: { fetch?: typeof fetch; timeoutMs?: number; pollMs?: number } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const client = new HttpAgentClient({ endpoint, credential, fetch: options.fetch });
  let manifest;
  try {
    manifest = await client.manifest();
    checks.push({ name: "Manifest at /.well-known/bugmole-agent.json is valid", ok: true, detail: `${manifest.name} (${manifest.id})` });
  } catch (error) {
    checks.push({ name: "Manifest at /.well-known/bugmole-agent.json is valid", ok: false, detail: (error as Error).message });
    return checks;
  }
  if (manifest.credential) {
    const wrong = new HttpAgentClient({ endpoint, credential: "bugmole-verify-wrong-credential", fetch: options.fetch });
    const refused = await wrong.status("bugmole-verify-none").then(() => false, (error) => error instanceof AgentProtocolError && (error.status === 401 || error.status === 403));
    checks.push({ name: "A wrong credential is refused (401 or 403)", ok: refused });
  }
  const id = `bugmole-verify-${Date.now()}`;
  const request: TaskRequest = {
    protocolVersion: 1,
    task: { id, title: "Bugmole conformance check", type: "investigation", prompt: "This is Bugmole's conformance check. Make no changes. Reply with a one-sentence summary saying you received this task." },
    settings: {},
  };
  try {
    const status = await client.run(request, { timeoutMs: options.timeoutMs ?? 5 * 60_000, pollMs: options.pollMs ?? 2_000 });
    checks.push({ name: "A task runs to the end with a valid status", ok: status.state === "completed", detail: status.state === "completed" ? status.result?.summary : status.error ?? status.state });
    const again = await client.start(request);
    checks.push({ name: "Starting the same task id again returns that task, not a new run", ok: again.id === id && again.state === status.state });
  } catch (error) {
    checks.push({ name: "A task runs to the end with a valid status", ok: false, detail: (error as Error).message });
  }
  return checks;
}
