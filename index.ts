import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assignmentId,
  candidateSessions,
  developerPrompt,
  findNameConflict,
  formatCandidate,
  normalizeIssueNumber,
  parsePairMessage,
  randomProjectName,
  reviewerPrompt,
  targetNames,
  type AcknowledgementMessage,
  type AssignmentMessage,
  type LiveSession,
  type PresenceMessage,
} from "./src/core.ts";

export const INTERCOM_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";
export const REVIEW_PAIR_NAMESPACE = "pi-intercom-review-pair/v2";

interface IntercomOwner {
  sessionId: string;
  epoch: string;
}

interface IntercomState {
  revision: number;
  payload: unknown;
}

type IntercomEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "owner"; owner?: IntercomOwner }
  | { type: "message"; fromSessionId: string; owner?: IntercomOwner; payload: unknown }
  | { type: "state"; state: IntercomState }
  | { type: "state_result"; committed: boolean; revision: number; reason?: string }
  | { type: "session_joined"; session: LiveSession }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: LiveSession };

interface IntercomChannel {
  readonly namespace: string;
  snapshot(): { connected: boolean; supported: boolean; owner?: IntercomOwner; state?: IntercomState };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  listSessions(): Promise<LiveSession[]>;
}

interface IntercomRegistration {
  namespace: string;
  ownerEligible: boolean;
  onEvent(event: IntercomEvent): void;
  onReady(channel: IntercomChannel): void;
}

interface AckResult {
  ok: boolean;
  name?: string;
  detail?: string;
}

interface PendingAssignment {
  expected: Set<string>;
  results: Map<string, AckResult>;
  resolve(results: Map<string, AckResult>): void;
  timer: NodeJS.Timeout;
}

const DISCOVERY_WAIT_MS = 250;
const ACK_WAIT_MS = 5_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortSession(session: LiveSession): string {
  return `${session.name || "Unnamed session"} [${session.id.slice(0, 8)}]`;
}

export default function reviewPairExtension(pi: ExtensionAPI): void {
  const instanceNonce = randomUUID();
  const peers = new Set<string>();
  const completedAssignments = new Map<string, AcknowledgementMessage>();
  const assignmentsInFlight = new Set<string>();
  const pendingAssignments = new Map<string, PendingAssignment>();
  let channel: IntercomChannel | undefined;
  let runtimeContext: ExtensionContext | undefined;
  let localSessionId: string | undefined;
  let registrationRequested = false;
  let commandRunning = false;

  const currentSessionId = (): string | undefined => {
    const intercomId = process.env.PI_INTERCOM_SESSION_ID?.trim();
    if (intercomId) return intercomId;
    if (localSessionId) return localSessionId;
    try {
      return runtimeContext?.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  };

  const publish = (payload: unknown): void => {
    if (!channel) throw new Error("pi-intercom review-pair channel is unavailable.");
    const snapshot = channel.snapshot();
    if (!snapshot.connected) throw new Error("pi-intercom is not connected.");
    if (!snapshot.supported) throw new Error("The connected pi-intercom broker does not support extension channels.");
    channel.publish(payload, { audience: "capable" });
  };

  const announce = (): void => {
    if (!channel) return;
    const snapshot = channel.snapshot();
    if (!snapshot.connected || !snapshot.supported) return;
    const message: PresenceMessage = { version: 2, type: "presence", nonce: instanceNonce };
    channel.publish(message, { audience: "capable" });
  };

  const sendAck = (message: AcknowledgementMessage): void => {
    try {
      publish(message);
    } catch {
      // A rerun republishes the cached successful acknowledgement after reconnect.
    }
  };

  const applyAssignment = async (message: AssignmentMessage, fromSessionId: string): Promise<void> => {
    if (!runtimeContext || !channel || message.coordinatorId !== fromSessionId || message.developerId !== fromSessionId) return;

    const issue = normalizeIssueNumber(message.issue);
    if (issue !== message.issue) return;
    const expectedAssignmentId = assignmentId(message.project, issue, message.developerId, message.reviewerId);
    if (message.assignmentId !== expectedAssignmentId) return;

    const self = currentSessionId();
    if (!self || (self !== message.developerId && self !== message.reviewerId)) return;
    const isDeveloper = self === message.developerId;
    const names = targetNames(message.project, issue);
    const expectedName = isDeveloper ? names.developer : names.reviewer;

    const completed = completedAssignments.get(message.assignmentId);
    if (completed) {
      sendAck(completed);
      return;
    }
    if (assignmentsInFlight.has(message.assignmentId)) return;
    assignmentsInFlight.add(message.assignmentId);

    try {
      const sessions = await channel.listSessions();
      const conflict = findNameConflict(sessions, expectedName, self);
      if (conflict) throw new Error(`Session name ${expectedName} is already used by ${shortSession(conflict)}.`);

      const developer = { id: message.developerId, name: names.developer };
      const reviewer = { id: message.reviewerId, name: names.reviewer };
      pi.setSessionName(expectedName);
      const prompt = isDeveloper
        ? developerPrompt(message.project, issue, reviewer)
        : reviewerPrompt(message.project, issue, developer);
      pi.sendUserMessage(prompt, runtimeContext.isIdle() ? undefined : { deliverAs: "followUp" });

      const ack: AcknowledgementMessage = {
        version: 2,
        type: "ack",
        assignmentId: message.assignmentId,
        ok: true,
        name: expectedName,
      };
      completedAssignments.set(message.assignmentId, ack);
      sendAck(ack);
    } catch (error) {
      sendAck({
        version: 2,
        type: "ack",
        assignmentId: message.assignmentId,
        ok: false,
        detail: errorMessage(error),
      });
    } finally {
      assignmentsInFlight.delete(message.assignmentId);
    }
  };

  const receiveAck = (message: AcknowledgementMessage, fromSessionId: string): void => {
    const pending = pendingAssignments.get(message.assignmentId);
    if (!pending || !pending.expected.has(fromSessionId) || pending.results.has(fromSessionId)) return;
    pending.results.set(fromSessionId, {
      ok: message.ok,
      ...(message.name ? { name: message.name } : {}),
      ...(message.detail ? { detail: message.detail } : {}),
    });
    if (pending.results.size === pending.expected.size) {
      clearTimeout(pending.timer);
      pendingAssignments.delete(message.assignmentId);
      pending.resolve(new Map(pending.results));
    }
  };

  const onIntercomEvent = (event: IntercomEvent): void => {
    if (event.type === "connection") {
      if (event.connected && event.supported) announce();
      return;
    }
    if (event.type === "session_joined") {
      announce();
      return;
    }
    if (event.type === "session_left") {
      peers.delete(event.sessionId);
      return;
    }
    if (event.type !== "message") return;

    const message = parsePairMessage(event.payload);
    if (!message) return;
    if (message.type === "presence") {
      peers.add(event.fromSessionId);
      if (message.nonce === instanceNonce) localSessionId = event.fromSessionId;
      return;
    }
    if (message.type === "discover") {
      announce();
      return;
    }
    if (message.type === "assign") {
      void applyAssignment(message, event.fromSessionId);
      return;
    }
    receiveAck(message, event.fromSessionId);
  };

  const requestRegistration = (): void => {
    if (registrationRequested) return;
    registrationRequested = true;
    const registration: IntercomRegistration = {
      namespace: REVIEW_PAIR_NAMESPACE,
      ownerEligible: false,
      onReady(value) {
        channel = value;
        announce();
      },
      onEvent: onIntercomEvent,
    };
    pi.events.emit(INTERCOM_REGISTER_EVENT, registration);
  };

  const discover = async (): Promise<{ sessions: LiveSession[]; self: string }> => {
    publish({ version: 2, type: "discover", requestId: randomUUID() });
    await delay(DISCOVERY_WAIT_MS);
    const sessions = await channel!.listSessions();
    const possibleSelf = currentSessionId();
    const self = possibleSelf && sessions.some((session) => session.id === possibleSelf)
      ? possibleSelf
      : undefined;
    if (!self) throw new Error("The current session is missing from the intercom roster.");
    return { sessions, self };
  };

  const chooseReviewer = async (
    sessions: LiveSession[],
    self: string,
    ctx: ExtensionCommandContext,
  ): Promise<LiveSession | undefined> => {
    const candidates = candidateSessions(sessions, peers, self);
    if (candidates.length === 0) throw new Error("No other live session advertises the review-pair extension.");
    if (candidates.length === 1) return candidates[0];

    const selected = await ctx.ui.select("Select reviewer", candidates.map(formatCandidate));
    return selected ? candidates.find((candidate) => formatCandidate(candidate) === selected) : undefined;
  };

  const awaitAcknowledgements = (
    message: AssignmentMessage,
    expected: string[],
  ): Promise<Map<string, AckResult>> => {
    return new Promise((resolve, reject) => {
      const results = new Map<string, AckResult>();
      const timer = setTimeout(() => {
        pendingAssignments.delete(message.assignmentId);
        resolve(results);
      }, ACK_WAIT_MS);
      pendingAssignments.set(message.assignmentId, { expected: new Set(expected), results, resolve, timer });
      try {
        publish(message);
      } catch (error) {
        clearTimeout(timer);
        pendingAssignments.delete(message.assignmentId);
        reject(error);
      }
    });
  };

  const runPairCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (commandRunning) {
      ctx.ui.notify("A review-pair command is already running in this session.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/pair-review requires an interactive or RPC UI.", "error");
      return;
    }
    commandRunning = true;
    try {
      const [issueArgument = "", ...projectArguments] = args.trim().split(/\s+/);
      let issueInput = issueArgument;
      if (!issueInput) {
        const entered = await ctx.ui.input("Issue number", "999");
        if (entered === undefined) return;
        issueInput = entered.trim();
      }
      const issue = normalizeIssueNumber(issueInput);

      let project = projectArguments.join(" ").trim();
      if (!project) {
        const entered = await ctx.ui.input("Project name (optional)", "Leave blank for a random word");
        if (entered === undefined) return;
        project = entered.trim() || randomProjectName();
      }

      const { sessions, self } = await discover();
      const developer = sessions.find((session) => session.id === self)!;
      const reviewer = await chooseReviewer(sessions, self, ctx);
      if (!reviewer) return;

      const names = targetNames(project, issue);
      const latestSessions = await channel!.listSessions();
      const developerConflict = findNameConflict(latestSessions, names.developer, developer.id);
      if (developerConflict) throw new Error(`${names.developer} is already used by ${shortSession(developerConflict)}.`);
      const reviewerConflict = findNameConflict(latestSessions, names.reviewer, reviewer.id);
      if (reviewerConflict) throw new Error(`${names.reviewer} is already used by ${shortSession(reviewerConflict)}.`);

      const confirmed = await ctx.ui.confirm(
        `Pair review for #${issue}?`,
        [
          `Developer: ${formatCandidate(developer)} → ${names.developer}`,
          `Reviewer: ${formatCandidate(reviewer)} → ${names.reviewer}`,
        ].join("\n"),
      );
      if (!confirmed) return;

      const id = assignmentId(project, issue, developer.id, reviewer.id);
      const assignment: AssignmentMessage = {
        version: 2,
        type: "assign",
        assignmentId: id,
        coordinatorId: self,
        project,
        issue,
        developerId: developer.id,
        reviewerId: reviewer.id,
      };
      const results = await awaitAcknowledgements(assignment, [developer.id, reviewer.id]);
      const verifyName = (result: AckResult | undefined, expectedName: string): AckResult | undefined => {
        if (!result?.ok || result.name === expectedName) return result;
        return { ok: false, detail: `acknowledged unexpected name ${result.name || "<missing>"}` };
      };
      const developerResult = verifyName(results.get(developer.id), names.developer);
      const reviewerResult = verifyName(results.get(reviewer.id), names.reviewer);
      if (developerResult?.ok && reviewerResult?.ok) {
        ctx.ui.notify(`Review pair active: ${names.developer} ↔ ${names.reviewer}`, "info");
        return;
      }

      const describe = (label: string, session: LiveSession, result: AckResult | undefined): string => {
        if (!result) return `${label} ${shortSession(session)}: no acknowledgement`;
        if (result.ok) return `${label} ${result.name || shortSession(session)}: ready`;
        return `${label} ${shortSession(session)}: ${result.detail || "assignment failed"}`;
      };
      ctx.ui.notify(
        `Review pair incomplete. ${describe("Developer", developer, developerResult)}; ${describe("Reviewer", reviewer, reviewerResult)}. Rerun /pair-review ${issue} ${project} after correcting the failed side.`,
        "error",
      );
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    } finally {
      commandRunning = false;
    }
  };

  const unsubscribeRegistryReady = pi.events.on(INTERCOM_REGISTRY_READY_EVENT, requestRegistration);
  pi.on("session_start", (_event, ctx) => {
    runtimeContext = ctx;
    requestRegistration();
    announce();
  });
  pi.on("session_shutdown", () => {
    unsubscribeRegistryReady();
    runtimeContext = undefined;
    peers.clear();
    for (const [id, pending] of pendingAssignments) {
      clearTimeout(pending.timer);
      pending.resolve(new Map(pending.results));
      pendingAssignments.delete(id);
    }
  });

  pi.registerCommand("pair-review", {
    description: "Pair and rename developer/reviewer Pi sessions for an issue",
    handler: runPairCommand,
  });
}
