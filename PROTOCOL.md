# The Bugmole agent protocol, version 1

[Bugmole](https://bugmole.com) finds bugs in an app and files them as tasks. When a person approves a task, a Bugmole worker hands it to the coding agent the project chose. This protocol is how a worker talks to an agent anyone can build.

An agent is described by a **manifest** and speaks one of two adapters:

- **http**: you host the agent. Workers (including Bugmole Cloud) reach it over HTTPS. Nothing is installed on the worker.
- **cli**: a command installed on the worker's machine. Self-hosted workers (`bugmole serve`) run it.

The types are in [`src/protocol.ts`](src/protocol.ts); this page is the prose.

## The manifest

```json
{
  "schemaVersion": 1,
  "id": "acme-coder",
  "name": "Acme Coder",
  "description": "Fixes the bugs Bugmole finds and opens a pull request.",
  "publisher": { "name": "Acme", "url": "https://acme.dev", "email": "agents@acme.dev" },
  "homepage": "https://acme.dev/coder",
  "protocol": "http",
  "endpoint": "https://coder.acme.dev",
  "credential": { "label": "Acme API key", "description": "From acme.dev → Settings → API keys." },
  "settings": [{ "key": "model", "label": "Model", "options": ["fast", "careful"] }],
  "capabilities": { "pullRequests": true }
}
```

- `id`: lowercase letters, digits and dashes; unique in the marketplace.
- `protocol`: `"http"` with `endpoint`, or `"cli"` with `command` and `install`.
- `credential`: what a workspace enters when it connects your agent. Bugmole stores it encrypted, never shows it again, and gives it only to the worker running one of that workspace's tasks: as a bearer token (http) or in the environment variable `credential.env` (cli; required there).
- `settings`: non-secret choices a workspace makes when it connects your agent, sent with every task.
- `capabilities`: what your agent does, shown to a workspace before it connects it. `pullRequests`: it changes the repository and opens a pull request. `localChanges`: it edits files in the worker's checkout (cli).

An http agent serves its manifest at `GET /.well-known/bugmole-agent.json`. Check one with `npx @bugmole/agent-kit check-manifest bugmole-agent.json`.

## The task

A worker sends a `TaskRequest`:

```json
{
  "protocolVersion": 1,
  "task": { "id": "task_abc", "title": "Give /api-keys the dashboard's header", "type": "code", "prompt": "…the full instructions…" },
  "repository": { "url": "https://github.com/acme/shop", "defaultBranch": "main" },
  "settings": { "model": "careful" }
}
```

`task.type` is `code` (change code), `ui` (change how it looks; Bugmole checks it against its design afterwards) or `investigation` (find out and report).

The agent answers with a `TaskStatus`:

```json
{ "id": "task_abc", "state": "completed", "result": { "summary": "Added the shared header.", "pullRequestUrl": "https://github.com/acme/shop/pull/12", "changedFiles": ["src/app/api-keys/page.tsx"] } }
```

- `state`: `queued`, `running`, `completed`, `failed` or `cancelled`.
- `progress`: the latest thing it's doing, shown on the task's card.
- `result.summary` (required when completed): one paragraph a reviewer reads first. A person reviews the task before it counts as done.
- `error` (required when failed): what went wrong, for a person.

## http

All requests carry `Authorization: Bearer <credential>` when the manifest has one. Answer `401` to a wrong one.

| Request | Answer |
| --- | --- |
| `GET /.well-known/bugmole-agent.json` | the manifest (no credential needed) |
| `POST /v1/tasks` with a `TaskRequest` | `201` and its `TaskStatus`. **Starting a task id that already exists returns that task, not a new run**: workers retry. |
| `GET /v1/tasks/:id` | its `TaskStatus`; `404` for an unknown id |
| `POST /v1/tasks/:id/cancel` | `202` and its `TaskStatus`, now `cancelled` unless it had already ended |

Workers poll `GET /v1/tasks/:id` every few seconds until the state is `completed`, `failed` or `cancelled`, and cancel after 30 minutes.

## cli

The worker writes the `TaskRequest` to a file and runs:

```
<command> run --task <file>
```

in the project's checkout, with the credential in `credential.env`. The command:

- prints lines `progress: <text>` on **stderr** as it works;
- prints its `TaskStatus` as one JSON line on **stdout** when it ends (the last JSON line counts);
- exits `0` when completed, non-zero otherwise.

## Getting listed

1. Build your agent with this kit (`defineHttpAgent` or `runAsCliAgent`).
2. Run `npx @bugmole/agent-kit verify <endpoint> --credential-env <NAME>` (http) until every check passes.
3. Submit your manifest to Bugmole. The Bugmole team reviews each agent before workspaces can connect it, because a connected agent gets a workspace's credential and changes its code.
