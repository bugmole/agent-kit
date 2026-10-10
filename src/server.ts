// Build an http agent: give it your manifest and a function that does the
// work; it answers the protocol's routes (PROTOCOL.md). It's a standard
// fetch handler, so it runs on Node (serveNode below), Cloudflare Workers,
// Deno and Bun alike.
//
//   const agent = defineHttpAgent({
//     manifest,
//     authorize: (token) => token === process.env.ACME_TOKEN,
//     async run(request, context) {
//       context.progress("Reading the repository…");
//       …
//       return { summary: "Fixed the header.", pullRequestUrl: "https://github.com/…" };
//     },
//   });
//   serveNode(agent, 8080);
//
// Tasks are kept in memory, which is right for one process. An agent that
// runs several processes, or must survive a restart, passes its own `store`.
import { createServer, type IncomingMessage } from "node:http";
import {
  manifestProblems,
  requestProblems,
  TERMINAL_STATES,
  type AgentManifest,
  type TaskRequest,
  type TaskResult,
  type TaskStatus,
} from "./protocol.ts";

export type RunContext = {
  /** The bearer token the worker sent: the workspace's credential for this agent. */
  credential: string | null;
  /** Shown on the task's card in Bugmole. */
  progress(text: string): void;
  /** Aborted when Bugmole cancels the task. */
  signal: AbortSignal;
};

export type TaskStore = {
  get(id: string): Promise<TaskStatus | undefined> | TaskStatus | undefined;
  set(status: TaskStatus): Promise<void> | void;
};

export type HttpAgentOptions = {
  manifest: AgentManifest;
  /**
   * Whether a request's bearer token may use the agent. Leave out only for an
   * agent that needs no credential.
   */
  authorize?: (token: string | null) => boolean | Promise<boolean>;
  run(request: TaskRequest, context: RunContext): Promise<TaskResult>;
  store?: TaskStore;
};

export type HttpAgent = { fetch(request: Request): Promise<Response> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryStore(): TaskStore {
  const tasks = new Map<string, TaskStatus>();
  return { get: (id) => tasks.get(id), set: (status) => { tasks.set(status.id, status); } };
}

export function defineHttpAgent(options: HttpAgentOptions): HttpAgent {
  const problems = manifestProblems(options.manifest);
  if (problems.length) throw new Error(`The manifest isn't valid: ${problems.join(" ")}`);
  if (options.manifest.protocol !== "http") throw new Error('defineHttpAgent needs a manifest with protocol "http".');
  const store = options.store ?? memoryStore();
  const running = new Map<string, AbortController>();

  async function authorized(request: Request): Promise<{ ok: boolean; token: string | null }> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() || null : null;
    if (!options.authorize) return { ok: true, token };
    return { ok: await options.authorize(token), token };
  }

  async function start(task: TaskRequest, token: string | null): Promise<TaskStatus> {
    const existing = await store.get(task.task.id);
    if (existing) return existing;
    const status: TaskStatus = { id: task.task.id, state: "running", progress: "Started" };
    await store.set(status);
    const controller = new AbortController();
    running.set(task.task.id, controller);
    const update = async (next: Partial<TaskStatus>) => {
      const current = await store.get(task.task.id);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      await store.set({ ...current, ...next });
    };
    void options.run(task, {
      credential: token,
      progress: (text) => void update({ progress: text.slice(0, 500) }),
      signal: controller.signal,
    }).then(
      (result) => update({ state: "completed", result, progress: undefined }),
      (error: unknown) => update({ state: "failed", error: error instanceof Error ? error.message : String(error) }),
    ).finally(() => running.delete(task.task.id));
    return status;
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/bugmole-agent.json") return json(options.manifest);
      const auth = await authorized(request);
      if (!auth.ok) return json({ error: "The credential wasn't accepted." }, 401);
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const body = await request.json().catch(() => null);
        const problems = requestProblems(body);
        if (problems.length) return json({ error: problems.join(" ") }, 422);
        const status = await start(body as TaskRequest, auth.token);
        return json(status, 201);
      }
      const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)(\/cancel)?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const status = await store.get(id);
        if (!status) return json({ error: "No such task." }, 404);
        if (match[2] && request.method === "POST") {
          running.get(id)?.abort();
          if (!TERMINAL_STATES.has(status.state)) await store.set({ ...status, state: "cancelled", progress: undefined });
          return json(await store.get(id), 202);
        }
        if (!match[2] && request.method === "GET") return json(status);
      }
      return json({ error: "Not found." }, 404);
    },
  };
}

async function readBody(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Serves an agent on Node's http server. Returns a function that stops it. */
export function serveNode(agent: HttpAgent, port: number, hostname = "0.0.0.0"): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (incoming, outgoing) => {
    const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
    const response = await agent.fetch(new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, { method: incoming.method, headers, body: body ? new Uint8Array(body) : undefined }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ url: `http://127.0.0.1:${actual}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
