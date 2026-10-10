import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestProblems, requestProblems, statusProblems, type TaskRequest } from "../src/protocol.ts";
import { HttpAgentClient, parseCliOutput, runCliAgent } from "../src/client.ts";
import { serveNode } from "../src/server.ts";
import { verifyHttpAgent } from "../src/verify.ts";
import { echoAgent, manifest } from "../examples/echo-http-agent.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const request = (id: string): TaskRequest => ({ protocolVersion: 1, task: { id, title: "Fix the header", type: "code", prompt: "Fix it." }, settings: {} });

test("a manifest says what's wrong with it", () => {
  assert.deepEqual(manifestProblems(manifest), []);
  assert.ok(manifestProblems({ ...manifest, id: "Has Spaces" }).some((problem) => problem.startsWith("id")));
  assert.ok(manifestProblems({ ...manifest, endpoint: "ftp://x" }).some((problem) => problem.includes("endpoint")));
  assert.ok(manifestProblems({ ...manifest, protocol: "cli", endpoint: undefined }).some((problem) => problem.includes("command")));
  assert.ok(manifestProblems({ ...manifest, protocol: "cli", command: "acme", install: "npm i -g acme", credential: { label: "Key" } }).some((problem) => problem.includes("env")));
  assert.deepEqual(manifestProblems("nope"), ["The manifest must be a JSON object."]);
});

test("requests and statuses are checked", () => {
  assert.deepEqual(requestProblems(request("t1")), []);
  assert.ok(requestProblems({ ...request("t1"), task: { id: "t1", title: "x", type: "other", prompt: "p" } }).length);
  assert.deepEqual(statusProblems({ id: "t1", state: "completed", result: { summary: "Done" } }), []);
  assert.ok(statusProblems({ id: "t1", state: "completed" }).length, "completed needs a summary");
  assert.ok(statusProblems({ id: "t1", state: "failed" }).length, "failed needs an error");
});

test("an http agent runs a task to the end, once per task id, and refuses a wrong credential", async () => {
  const server = await serveNode(echoAgent("s3cret"), 0, "127.0.0.1");
  try {
    const client = new HttpAgentClient({ endpoint: server.url, credential: "s3cret" });
    const progress: string[] = [];
    const done = await client.run(request("t1"), { pollMs: 20, onProgress: (text) => progress.push(text) });
    assert.equal(done.state, "completed");
    assert.equal(done.result?.summary, 'Received "Fix the header" (code).');
    assert.equal((await client.start(request("t1"))).state, "completed", "the same id doesn't start again");
    await assert.rejects(new HttpAgentClient({ endpoint: server.url, credential: "wrong" }).status("t1"), /wasn't accepted/);
    const checks = await verifyHttpAgent(server.url, "s3cret", { pollMs: 20 });
    assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
  } finally {
    await server.close();
  }
});

test("a cli agent gets the task in a file and its credential in the environment", async () => {
  const command = { command: process.execPath, args: [path.join(here, "../examples/echo-cli-agent.ts")] };
  const progress: string[] = [];
  const ok = await runCliAgent(request("t2"), { ...command, env: { ECHO_TOKEN: "x" }, onProgress: (text) => progress.push(text) });
  assert.equal(ok.state, "completed", JSON.stringify(ok));
  assert.equal(ok.result?.summary, 'Received "Fix the header".');
  assert.deepEqual(progress, ["Reading the task"]);
  const failed = await runCliAgent(request("t3"), { ...command, env: { ECHO_TOKEN: "" } });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "ECHO_TOKEN isn't set.");
  const missing = await runCliAgent(request("t4"), { command: "bugmole-agent-that-does-not-exist" });
  assert.match(missing.error ?? "", /isn't installed/);
});

test("a cli agent's status is the last JSON line it printed", () => {
  assert.deepEqual(parseCliOutput('log line\n{"id":"t","state":"completed","result":{"summary":"ok"}}\n'), { id: "t", state: "completed", result: { summary: "ok" } });
  assert.equal(parseCliOutput("nothing"), null);
});
