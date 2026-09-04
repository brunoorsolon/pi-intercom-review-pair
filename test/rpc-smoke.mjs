import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const intercomExtension = process.env.PI_INTERCOM_EXTENSION;
if (!intercomExtension) throw new Error("Set PI_INTERCOM_EXTENSION to pi-intercom's index.ts.");
const piBin = process.env.PI_BIN || "pi";
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const brokerSocket = join(agentDir, "intercom", "broker.sock");
const project = basename(root);
let requestNumber = 0;

async function requireExistingBroker() {
  await new Promise((resolveConnection, reject) => {
    const socket = createConnection(brokerSocket);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection();
    });
    socket.once("error", () => reject(new Error(`A live broker is required at ${brokerSocket}; this smoke will not start one.`)));
  });
}

class RpcClient {
  constructor(role, reviewPair = true) {
    this.role = role;
    this.pending = new Map();
    this.events = [];
    this.stderr = "";
    const environment = {
      ...process.env,
      PI_INTERCOM_ASK_TIMEOUT_MS: "3600000",
      PAIR_SMOKE_API_KEY: "unused",
      PAIR_SMOKE_ROLE: role,
    };
    delete environment.AI_AGENTS_SANDBOX_PROJECT_NAME;
    delete environment.AI_AGENTS_SANDBOX_ACTOR_IDENTITY;
    delete environment.PI_INTERCOM_SCOPE_ID;
    this.child = spawn(piBin, [
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--provider", "pair-smoke",
      "--model", "pair-smoke-model",
      "-e", intercomExtension,
      ...(reviewPair ? ["-e", join(root, "index.ts")] : []),
      "-e", join(root, "test", "fixtures", "fake-provider.ts"),
    ], {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.once("exit", (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`${role} exited (${code ?? signal}): ${this.stderr}`));
      this.pending.clear();
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.events.push(message);
    if (message.type === "extension_ui_request") {
      if (message.method === "select") {
        const value = message.options.includes(showUnnamed) ? showUnnamed : message.options[0];
        this.send({ type: "extension_ui_response", id: message.id, value });
      } else if (message.method === "confirm") {
        this.send({ type: "extension_ui_response", id: message.id, confirmed: true });
      } else if (["input", "editor"].includes(message.method)) {
        this.send({ type: "extension_ui_response", id: message.id, value: "710" });
      }
      return;
    }
    if (message.type !== "response" || !message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.success) pending.resolve(message);
    else pending.reject(new Error(`${this.role} ${message.command} failed: ${message.error}`));
  }

  request(command, timeoutMs = 30_000) {
    const id = `${this.role}-${++requestNumber}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.role} timed out waiting for ${command.type}: ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.send({ ...command, id });
    });
  }

  async waitIdle() {
    let stable = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = (await this.request({ type: "get_state" })).data;
      stable = !state.isStreaming && state.pendingMessageCount === 0 ? stable + 1 : 0;
      if (stable === 3) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`${this.role} did not become idle.`);
  }

  async state() {
    return (await this.request({ type: "get_state" })).data;
  }

  async messages() {
    return (await this.request({ type: "get_messages" })).data.messages;
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolveExit) => this.child.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }
}

function occurrences(messages, marker) {
  return JSON.stringify(messages).split(marker).length - 1;
}

await requireExistingBroker();
const clients = [new RpcClient("developer"), new RpcClient("reviewer"), new RpcClient("unrelated", false)];
const [developer, reviewer, unrelated] = clients;
try {
  await Promise.all(clients.map((client) => client.request({ type: "get_commands" })));
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await developer.request({ type: "prompt", message: "/pair-review #0710" });
  await Promise.all(clients.map((client) => client.waitIdle()));
  assert.equal((await developer.state()).sessionName, `${project}-710`);
  assert.equal((await reviewer.state()).sessionName, `${project}-710-review`);
  assert.equal((await unrelated.state()).sessionName, undefined);
  const reviewerSelections = developer.events.filter((event) => event.type === "extension_ui_request" && event.method === "select" && event.title === "Select reviewer");
  assert.equal(reviewerSelections.length, 0);

  const firstDeveloperMessages = await developer.messages();
  const firstReviewerMessages = await reviewer.messages();
  assert.equal(occurrences(firstDeveloperMessages, "You are the developer for issue #710"), 1);
  assert.equal(occurrences(firstReviewerMessages, "You are the read-only reviewer for issue #710"), 1);

  await developer.request({ type: "prompt", message: "/pair-review 710" });
  await Promise.all(clients.map((client) => client.waitIdle()));
  assert.equal(occurrences(await developer.messages(), "You are the developer for issue #710"), 1);
  assert.equal(occurrences(await reviewer.messages(), "You are the read-only reviewer for issue #710"), 1);

  await developer.request({ type: "prompt", message: "BEGIN_FAKE_REVIEW_LOOP" });
  await Promise.all(clients.map((client) => client.waitIdle()));
  const developerTranscript = JSON.stringify(await developer.messages());
  const reviewerTranscript = JSON.stringify(await reviewer.messages());
  for (const marker of ["FAKE_REVIEW_REQUEST_1", "FINDING: repair the fake regression", "FAKE_REVIEW_REQUEST_2 repaired", "No findings.", "repair-review-loop-complete"]) {
    assert.match(developerTranscript, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(reviewerTranscript, /FAKE_REVIEW_REQUEST_1/);
  assert.match(reviewerTranscript, /FAKE_REVIEW_REQUEST_2 repaired/);
  assert.match(reviewerTranscript, /No findings\./);

  const activeNotice = developer.events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes("Review pair active"));
  assert.ok(activeNotice);
  console.log(JSON.stringify({
    project,
    developer: (await developer.state()).sessionName,
    reviewer: (await reviewer.state()).sessionName,
    unrelated: (await unrelated.state()).sessionName ?? null,
    rolePromptCount: { developer: 1, reviewer: 1 },
    repairReviewLoop: "No findings.",
  }));
} finally {
  await Promise.all(clients.map((client) => client.stop()));
}
