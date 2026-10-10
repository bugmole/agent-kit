// The Bugmole agent protocol, version 1. See PROTOCOL.md for the prose.
//
// A Bugmole worker hands an approved task to a coding agent and waits for its
// result. An agent is either:
//   - "http": a service the agent's developer hosts. The worker starts a task
//     with POST /v1/tasks and polls GET /v1/tasks/:id until it ends.
//   - "cli": a command installed on the worker's machine. The worker runs it
//     with the task in a JSON file and reads its result from stdout.
// Either way the agent is described by a manifest, which is what a developer
// submits to Bugmole's marketplace.

export const PROTOCOL_VERSION = 1;

/** A setting a workspace fills in when it connects the agent (not secret). */
export type ManifestSetting = {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  /** Offered choices; free text when absent. */
  options?: string[];
};

export type AgentManifest = {
  schemaVersion: 1;
  /** Lowercase letters, digits and dashes; unique in the marketplace. */
  id: string;
  name: string;
  description: string;
  publisher: { name: string; url?: string; email?: string };
  homepage?: string;
  protocol: "http" | "cli";
  /** http: the agent's base URL (https). */
  endpoint?: string;
  /** cli: the command the worker runs, and how a person installs it. */
  command?: string;
  install?: string;
  /**
   * The workspace's credential for this agent, sent as a bearer token (http)
   * or put in this environment variable (cli). Omit when the agent needs none.
   */
  credential?: { label: string; env?: string; required?: boolean; description?: string };
  settings?: ManifestSetting[];
  /** What the agent does with a task, shown before a workspace connects it. */
  capabilities: {
    /** It changes the repository and opens a pull request. */
    pullRequests?: boolean;
    /** It edits files in the worker's checkout (cli agents). */
    localChanges?: boolean;
  };
};

export type TaskType = "code" | "ui" | "investigation";

/** What the worker sends: POST /v1/tasks (http) or the --task file (cli). */
export type TaskRequest = {
  protocolVersion: 1;
  task: {
    /** Bugmole's task id. Starting the same id twice must not start two runs. */
    id: string;
    title: string;
    type: TaskType;
    /** The full instructions, ready to give to a model. */
    prompt: string;
  };
  /** Where the code is, when Bugmole knows (http agents work in their own copy). */
  repository?: { url: string; defaultBranch?: string };
  /** The workspace's settings for this agent, by ManifestSetting.key. */
  settings: Record<string, string>;
};

export type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled";

export type TaskResult = {
  /** One paragraph a reviewer reads first. */
  summary: string;
  pullRequestUrl?: string;
  changedFiles?: string[];
};

/** GET /v1/tasks/:id (http), or the cli command's stdout. */
export type TaskStatus = {
  id: string;
  state: TaskState;
  /** The latest thing the agent is doing, shown on the task's card. */
  progress?: string;
  /** Present when completed. */
  result?: TaskResult;
  /** Present when failed: what went wrong, for a person. */
  error?: string;
};

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled"]);

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** Every problem with a manifest, in words a developer can fix; empty when it's valid. */
export function manifestProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["The manifest must be a JSON object."];
  const problems: string[] = [];
  if (value.schemaVersion !== 1) problems.push("schemaVersion must be 1.");
  if (typeof value.id !== "string" || !ID.test(value.id)) problems.push("id must be lowercase letters, digits and dashes (up to 64).");
  if (!text(value.name, 60)) problems.push("name is required (up to 60 characters).");
  if (!text(value.description, 500)) problems.push("description is required (up to 500 characters).");
  if (!isRecord(value.publisher) || !text(value.publisher.name, 80)) problems.push("publisher.name is required.");
  if (isRecord(value.publisher) && value.publisher.url !== undefined && !httpsUrl(value.publisher.url)) problems.push("publisher.url must be an https URL.");
  if (value.homepage !== undefined && !httpsUrl(value.homepage)) problems.push("homepage must be an https URL.");
  if (value.protocol === "http") {
    if (!httpsUrl(value.endpoint)) problems.push("An http agent needs endpoint: its https base URL.");
  } else if (value.protocol === "cli") {
    if (!text(value.command, 200)) problems.push("A cli agent needs command: what the worker runs.");
    if (!text(value.install, 300)) problems.push("A cli agent needs install: how a person installs the command.");
  } else {
    problems.push('protocol must be "http" or "cli".');
  }
  if (value.credential !== undefined) {
    const credential = value.credential;
    if (!isRecord(credential) || !text(credential.label, 80)) problems.push("credential.label is required when there's a credential.");
    else if (credential.env !== undefined && (typeof credential.env !== "string" || !ENV.test(credential.env))) problems.push("credential.env must be an environment variable name like ACME_API_KEY.");
    else if (value.protocol === "cli" && !credential.env) problems.push("A cli agent's credential needs env: the variable the command reads.");
  }
  if (value.settings !== undefined) {
    if (!Array.isArray(value.settings) || value.settings.length > 20) problems.push("settings must be a list of up to 20 settings.");
    else {
      const keys = new Set<string>();
      value.settings.forEach((setting, index) => {
        if (!isRecord(setting) || typeof setting.key !== "string" || !KEY.test(setting.key) || !text(setting.label, 80)) problems.push(`settings[${index}] needs a key (letters, digits, _) and a label.`);
        else if (keys.has(setting.key)) problems.push(`settings[${index}].key ${setting.key} is used twice.`);
        else keys.add(setting.key);
      });
    }
  }
  if (!isRecord(value.capabilities)) problems.push("capabilities is required, e.g. { \"pullRequests\": true }.");
  return problems;
}

/** Every problem with a task status; empty when it's valid. */
export function statusProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["A task status must be a JSON object."];
  const problems: string[] = [];
  if (!text(value.id, 200)) problems.push("id is required.");
  if (!["queued", "running", "completed", "failed", "cancelled"].includes(value.state as string)) problems.push("state must be queued, running, completed, failed or cancelled.");
  if (value.progress !== undefined && typeof value.progress !== "string") problems.push("progress must be text.");
  if (value.state === "completed") {
    if (!isRecord(value.result) || !text(value.result.summary, 20_000)) problems.push("A completed task needs result.summary.");
    else if (value.result.pullRequestUrl !== undefined && !httpsUrl(value.result.pullRequestUrl)) problems.push("result.pullRequestUrl must be a URL.");
  }
  if (value.state === "failed" && !text(value.error, 20_000)) problems.push("A failed task needs error: what went wrong.");
  return problems;
}

/** Every problem with a task request; empty when it's valid. */
export function requestProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["A task request must be a JSON object."];
  const problems: string[] = [];
  if (value.protocolVersion !== 1) problems.push("protocolVersion must be 1.");
  const task = value.task;
  if (!isRecord(task) || !text(task.id, 200) || !text(task.title, 500) || !text(task.prompt, 200_000)) problems.push("task needs id, title and prompt.");
  else if (!["code", "ui", "investigation"].includes(task.type as string)) problems.push("task.type must be code, ui or investigation.");
  if (!isRecord(value.settings)) problems.push("settings must be an object (empty when there are none).");
  return problems;
}
