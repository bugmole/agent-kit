// The worker's side of the protocol: start a task on an http agent and follow
// it to the end, or run a cli agent's command. Bugmole's worker uses this; so
// does `bugmole-agent-kit verify`.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { manifestProblems, statusProblems, TERMINAL_STATES, type AgentManifest, type TaskRequest, type TaskStatus } from "./protocol.ts";

export class AgentProtocolError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AgentProtocolError";
    this.status = status;
  }
}

export type HttpAgentClientOptions = {
  endpoint: string;
  credential?: string | null;
  fetch?: typeof fetch;
};

export type FollowOptions = {
  /** Gives up (and asks the agent to cancel) after this long. Default 30 minutes. */
  timeoutMs?: number;
  /** Default 5 seconds. */
  pollMs?: number;
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class HttpAgentClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly credential: string | null;

  constructor(options: HttpAgentClientOptions) {
    this.base = options.endpoint.replace(/\/+$/, "");
    this.doFetch = options.fetch ?? fetch;
    this.credential = options.credential ?? null;
  }

  private async call<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.doFetch(`${this.base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
    const parsed = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok) throw new AgentProtocolError(parsed?.error ?? `The agent answered ${response.status} to ${method} ${pathname}.`, response.status);
    if (parsed === null) throw new AgentProtocolError(`The agent's answer to ${method} ${pathname} wasn't JSON.`, response.status);
    return parsed;
  }

  async manifest(): Promise<AgentManifest> {
    const manifest = await this.call<AgentManifest>("GET", "/.well-known/bugmole-agent.json");
    const problems = manifestProblems(manifest);
    if (problems.length) throw new AgentProtocolError(`The agent's manifest isn't valid: ${problems.join(" ")}`);
    return manifest;
  }

  private checked(status: TaskStatus): TaskStatus {
    const problems = statusProblems(status);
    if (problems.length) throw new AgentProtocolError(`The agent's task status isn't valid: ${problems.join(" ")}`);
    return status;
  }

  async start(request: TaskRequest): Promise<TaskStatus> {
    return this.checked(await this.call<TaskStatus>("POST", "/v1/tasks", request));
  }

  async status(id: string): Promise<TaskStatus> {
    return this.checked(await this.call<TaskStatus>("GET", `/v1/tasks/${encodeURIComponent(id)}`));
  }

  async cancel(id: string): Promise<TaskStatus> {
    return this.checked(await this.call<TaskStatus>("POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`));
  }

  /** Starts the task (or picks up the run already going) and waits until it ends. */
  async run(request: TaskRequest, options: FollowOptions = {}): Promise<TaskStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    let status = await this.start(request);
    let lastProgress = "";
    while (!TERMINAL_STATES.has(status.state)) {
      if (status.progress && status.progress !== lastProgress) {
        lastProgress = status.progress;
        options.onProgress?.(status.progress);
      }
      if (options.signal?.aborted || Date.now() > deadline) {
        await this.cancel(request.task.id).catch(() => undefined);
        return { id: request.task.id, state: "failed", error: options.signal?.aborted ? "Cancelled by the worker." : "The agent didn't finish in time." };
      }
      await sleep(options.pollMs ?? 5_000, options.signal);
      status = await this.status(request.task.id);
    }
    return status;
  }
}

export type CliRunOptions = {
  command: string;
  args?: string[];
  /** Added to the command's environment, e.g. the credential under manifest.credential.env. */
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  onProgress?: (text: string) => void;
};

/** The last JSON object a cli agent printed on stdout: its TaskStatus. */
export function parseCliOutput(stdout: string): TaskStatus | null {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as TaskStatus;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not a JSON line; keep looking.
    }
  }
  return null;
}

/**
 * Runs a cli agent: writes the task to a temporary file, runs
 * `<command> run --task <file>`, and reads its TaskStatus from stdout.
 * Lines it prints on stderr as "progress: …" are progress.
 */
export async function runCliAgent(request: TaskRequest, options: CliRunOptions): Promise<TaskStatus> {
  const directory = await mkdtemp(path.join(tmpdir(), "bugmole-task-"));
  const file = path.join(directory, "task.json");
  try {
    await writeFile(file, JSON.stringify(request), { mode: 0o600 });
    const { stdout, error } = await new Promise<{ stdout: string; error: NodeJS.ErrnoException & { killed?: boolean } | null }>((resolve) => {
      const child = execFile(options.command, [...(options.args ?? []), "run", "--task", file], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? 30 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      }, (failure, out) => resolve({ stdout: String(out ?? ""), error: failure as never }));
      let buffered = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("progress: ")) options.onProgress?.(line.slice(10));
      });
    });
    if (error?.code === "ENOENT") return { id: request.task.id, state: "failed", error: `${options.command} isn't installed on this worker.` };
    if (error?.killed) return { id: request.task.id, state: "failed", error: `${options.command} didn't finish in time.` };
    const status = parseCliOutput(stdout);
    if (!status) return { id: request.task.id, state: "failed", error: error?.message ?? `${options.command} printed no task status.` };
    const problems = statusProblems(status);
    return problems.length ? { id: request.task.id, state: "failed", error: `${options.command} printed an invalid task status: ${problems.join(" ")}` } : status;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
