import assert from "node:assert/strict";
import test from "node:test";
import reviewPairExtension, { INTERCOM_REGISTER_EVENT } from "../index.ts";

class EventBus {
  listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }
}

interface SessionRecord {
  id: string;
  name?: string;
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  status: string;
}

interface Registration {
  namespace: string;
  onReady(channel: unknown): void;
  onEvent(event: unknown): void;
}

class FakeBroker {
  sessions = new Map<string, SessionRecord>();
  registrations = new Map<string, Registration>();

  addSession(session: SessionRecord): void {
    this.sessions.set(session.id, session);
  }

  install(pi: FakePi): void {
    pi.events.on(INTERCOM_REGISTER_EVENT, (payload) => {
      const registration = payload as Registration;
      this.registrations.set(pi.session.id, registration);
      const channel = {
        namespace: registration.namespace,
        snapshot: () => ({ connected: true, supported: true }),
        publish: (message: unknown) => this.publish(pi.session.id, message),
        listSessions: async () => [...this.sessions.values()].map((session) => ({ ...session })),
      };
      registration.onReady(channel);
      registration.onEvent({ type: "connection", connected: true, supported: true });
      for (const [id, peer] of this.registrations) {
        if (id === pi.session.id) continue;
        peer.onEvent({ type: "session_joined", session: { ...pi.session } });
        registration.onEvent({ type: "session_joined", session: { ...this.sessions.get(id)! } });
      }
    });
  }

  publish(fromSessionId: string, payload: unknown): void {
    for (const registration of this.registrations.values()) {
      registration.onEvent({ type: "message", fromSessionId, payload });
    }
  }

  rename(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId)!;
    session.name = name;
    session.runtimeFallbackAlias = false;
  }
}

class FakePi {
  events = new EventBus();
  lifecycle = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  commands = new Map<string, { handler(args: string, context: unknown): Promise<void> }>();
  prompts: string[] = [];
  notifications: Array<{ message: string; level: string }> = [];
  selectOptions: string[][] = [];
  confirmations: Array<{ title: string; message: string }> = [];
  promptFailures = 0;
  inputValue: string | undefined;
  broker: FakeBroker;
  session: SessionRecord;
  context: Record<string, unknown>;

  constructor(broker: FakeBroker, session: SessionRecord) {
    this.broker = broker;
    this.session = session;
    this.context = {
      hasUI: true,
      isIdle: () => true,
      sessionManager: { getSessionId: () => this.session.id },
      ui: {
        input: async () => this.inputValue,
        select: async (_title: string, options: string[]) => {
          this.selectOptions.push([...options]);
          return options.includes("Show unnamed sessions…") ? "Show unnamed sessions…" : options[0];
        },
        confirm: async (title: string, message: string) => {
          this.confirmations.push({ title, message });
          return true;
        },
        notify: (message: string, level: string) => this.notifications.push({ message, level }),
      },
    };
    broker.addSession(session);
    broker.install(this);
  }

  on(event: string, handler: (event: unknown, context: unknown) => unknown): void {
    const handlers = this.lifecycle.get(event) ?? [];
    handlers.push(handler);
    this.lifecycle.set(event, handlers);
  }

  registerCommand(name: string, command: { handler(args: string, context: unknown): Promise<void> }): void {
    this.commands.set(name, command);
  }

  setSessionName(name: string): void {
    this.broker.rename(this.session.id, name);
  }

  getSessionName(): string | undefined {
    return this.session.name;
  }

  sendUserMessage(message: string): void {
    if (this.promptFailures > 0) {
      this.promptFailures -= 1;
      throw new Error("prompt injection failed");
    }
    this.prompts.push(message);
  }

  async start(): Promise<void> {
    for (const handler of this.lifecycle.get("session_start") ?? []) await handler({}, this.context);
  }

  async invoke(args: string): Promise<void> {
    await this.commands.get("pair-review")!.handler(args, this.context);
  }
}

function addExtension(broker: FakeBroker, session: SessionRecord, actorIdentity: string, project = "billing"): FakePi {
  const previousProject = process.env.AI_AGENTS_SANDBOX_PROJECT_NAME;
  const previousActor = process.env.AI_AGENTS_SANDBOX_ACTOR_IDENTITY;
  process.env.AI_AGENTS_SANDBOX_PROJECT_NAME = project;
  process.env.AI_AGENTS_SANDBOX_ACTOR_IDENTITY = actorIdentity;
  const pi = new FakePi(broker, session);
  reviewPairExtension(pi as never);
  if (previousProject === undefined) delete process.env.AI_AGENTS_SANDBOX_PROJECT_NAME;
  else process.env.AI_AGENTS_SANDBOX_PROJECT_NAME = previousProject;
  if (previousActor === undefined) delete process.env.AI_AGENTS_SANDBOX_ACTOR_IDENTITY;
  else process.env.AI_AGENTS_SANDBOX_ACTOR_IDENTITY = previousActor;
  return pi;
}

async function setup(reviewPromptFailures = 0): Promise<{ base: FakePi; reviewer: FakePi; broker: FakeBroker; restore(): void }> {
  const previousScope = process.env.PI_INTERCOM_SCOPE_ID;
  const previousSessionId = process.env.PI_INTERCOM_SESSION_ID;
  process.env.PI_INTERCOM_SCOPE_ID = "billing";
  delete process.env.PI_INTERCOM_SESSION_ID;

  const broker = new FakeBroker();
  const base = addExtension(broker, {
    id: "developer-session",
    runtimeFallbackAlias: true,
    cwd: "/project/repo",
    model: "gpt",
    status: "idle",
  }, "gpt");
  const reviewer = addExtension(broker, {
    id: "reviewer-session",
    runtimeFallbackAlias: true,
    cwd: "/project/repo",
    model: "gpt",
    status: "idle",
  }, "gpt-reviewer");
  reviewer.promptFailures = reviewPromptFailures;
  broker.addSession({
    id: "unrelated-unnamed",
    runtimeFallbackAlias: true,
    cwd: "/project/repo",
    model: "gpt",
    status: "idle",
  });
  await base.start();
  await reviewer.start();

  return {
    base,
    reviewer,
    broker,
    restore() {
      if (previousScope === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
      else process.env.PI_INTERCOM_SCOPE_ID = previousScope;
      if (previousSessionId === undefined) delete process.env.PI_INTERCOM_SESSION_ID;
      else process.env.PI_INTERCOM_SESSION_ID = previousSessionId;
    },
  };
}

test("pairs live sessions, hides unnamed peers, and reruns without duplicate prompts", async () => {
  const scenario = await setup();
  try {
    scenario.base.inputValue = "#0710";
    await scenario.base.invoke("");

    assert.equal(scenario.base.session.name, "billing-710");
    assert.equal(scenario.reviewer.session.name, "billing-710-review");
    assert.equal(scenario.base.prompts.length, 1);
    assert.equal(scenario.reviewer.prompts.length, 1);
    assert.deepEqual(scenario.base.selectOptions[0], ["Show unnamed sessions…"]);
    assert.match(scenario.base.confirmations[0]!.message, /developer-session/);
    assert.match(scenario.base.confirmations[0]!.message, /reviewer-session/);
    assert.match(scenario.base.notifications.at(-1)!.message, /Review pair active/);

    await scenario.base.invoke("710");
    assert.equal(scenario.base.prompts.length, 1);
    assert.equal(scenario.reviewer.prompts.length, 1);
    assert.match(scenario.base.notifications.at(-1)!.message, /Review pair active/);
  } finally {
    scenario.restore();
  }
});

test("can coordinate the pair from the reviewer session", async () => {
  const scenario = await setup();
  try {
    await scenario.reviewer.invoke("713");
    assert.equal(scenario.base.session.name, "billing-713");
    assert.equal(scenario.reviewer.session.name, "billing-713-review");
    assert.match(scenario.reviewer.notifications.at(-1)!.message, /Review pair active/);
  } finally {
    scenario.restore();
  }
});

test("reports each side on partial failure and converges on rerun", async () => {
  const scenario = await setup(1);
  try {
    await scenario.base.invoke("711");
    assert.match(scenario.base.notifications.at(-1)!.message, /Review pair incomplete/);
    assert.match(scenario.base.notifications.at(-1)!.message, /Developer billing-711: ready/);
    assert.match(scenario.base.notifications.at(-1)!.message, /Reviewer .*prompt injection failed/);
    assert.equal(scenario.base.prompts.length, 1);
    assert.equal(scenario.reviewer.prompts.length, 0);

    await scenario.base.invoke("711");
    assert.match(scenario.base.notifications.at(-1)!.message, /Review pair active/);
    assert.equal(scenario.base.prompts.length, 1);
    assert.equal(scenario.reviewer.prompts.length, 1);
  } finally {
    scenario.restore();
  }
});

test("rejects invalid issue input before side effects", async () => {
  const scenario = await setup();
  try {
    await scenario.base.invoke("issue-710");
    scenario.base.inputValue = "";
    await scenario.base.invoke("");
    assert.equal(scenario.base.session.name, undefined);
    assert.equal(scenario.reviewer.session.name, undefined);
    assert.equal(scenario.base.prompts.length, 0);
    assert.equal(scenario.reviewer.prompts.length, 0);
    assert.equal(scenario.base.confirmations.length, 0);
    assert.match(scenario.base.notifications.at(-1)!.message, /only digits/);
  } finally {
    scenario.restore();
  }
});

test("rejects an ambiguous duplicate target name before confirmation", async () => {
  const scenario = await setup();
  try {
    scenario.broker.addSession({
      id: "existing-name",
      name: "billing-712-review",
      cwd: "/project/repo",
      model: "gpt",
      status: "idle",
    });
    await scenario.base.invoke("712");
    assert.equal(scenario.base.prompts.length, 0);
    assert.equal(scenario.reviewer.prompts.length, 0);
    assert.equal(scenario.base.confirmations.length, 0);
    assert.match(scenario.base.notifications.at(-1)!.message, /already used/);
  } finally {
    scenario.restore();
  }
});
