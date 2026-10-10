#!/usr/bin/env node
// bugmole-agent-kit verify <endpoint> [--credential-env NAME]
// bugmole-agent-kit check-manifest <bugmole-agent.json>
import { readFile } from "node:fs/promises";
import { manifestProblems } from "./protocol.ts";
import { verifyHttpAgent } from "./verify.ts";

const [command, target, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};

if (command === "verify" && target) {
  const credentialEnv = option("--credential-env");
  const credential = credentialEnv ? process.env[credentialEnv] ?? null : null;
  if (credentialEnv && !credential) {
    console.error(`${credentialEnv} isn't set.`);
    process.exit(2);
  }
  const checks = await verifyHttpAgent(target, credential);
  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
} else if (command === "check-manifest" && target) {
  const problems = manifestProblems(JSON.parse(await readFile(target, "utf8")));
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  if (!problems.length) console.log("PASS  The manifest is valid.");
  process.exit(problems.length ? 1 : 0);
} else {
  console.error("usage: bugmole-agent-kit verify <endpoint> [--credential-env NAME]\n       bugmole-agent-kit check-manifest <bugmole-agent.json>");
  process.exit(2);
}
