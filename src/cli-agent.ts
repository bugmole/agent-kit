// Build a cli agent: a command the Bugmole worker runs as
// `<command> run --task <file>`. Write the work as a function; this reads the
// task, gives you the credential from your manifest's environment variable,
// prints progress on stderr and the TaskStatus on stdout.
//
//   #!/usr/bin/env node
//   import { runAsCliAgent } from "bugmole-agent-kit/cli";
//   await runAsCliAgent({ credentialEnv: "ACME_API_KEY", async run(request, context) {
//     context.progress("Editing files…");
//     return { summary: "Fixed the header.", changedFiles: ["src/header.tsx"] };
//   } });
import { readFile } from "node:fs/promises";
import { requestProblems, type TaskRequest, type TaskResult, type TaskStatus } from "./protocol.ts";

export type CliRunContext = {
  credential: string | null;
  progress(text: string): void;
};

export type CliAgentOptions = {
  /** The variable your manifest's credential.env names. */
  credentialEnv?: string;
  run(request: TaskRequest, context: CliRunContext): Promise<TaskResult>;
  /** Test seams. */
  argv?: string[];
  env?: Record<string, string | undefined>;
  write?: (stream: "stdout" | "stderr", text: string) => void;
};

/** Runs the agent for one task and returns the exit code (0 when it completed). */
export async function runAsCliAgent(options: CliAgentOptions): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const write = options.write ?? ((stream, text) => process[stream].write(text));
  const finish = (status: TaskStatus) => {
    write("stdout", `${JSON.stringify(status)}\n`);
    return status.state === "completed" ? 0 : 1;
  };
  const file = argv[0] === "run" && argv[1] === "--task" ? argv[2] : undefined;
  if (!file) {
    write("stderr", "usage: <command> run --task <task.json>\n");
    return 2;
  }
  const request = JSON.parse(await readFile(file, "utf8")) as TaskRequest;
  const problems = requestProblems(request);
  if (problems.length) return finish({ id: request?.task?.id ?? "unknown", state: "failed", error: problems.join(" ") });
  try {
    const result = await options.run(request, {
      credential: options.credentialEnv ? env[options.credentialEnv]?.trim() || null : null,
      progress: (text) => write("stderr", `progress: ${text.replace(/\s+/g, " ").slice(0, 500)}\n`),
    });
    return finish({ id: request.task.id, state: "completed", result });
  } catch (error) {
    return finish({ id: request.task.id, state: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}
