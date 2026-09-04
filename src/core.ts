import { basename, resolve } from "node:path";

export interface LiveSession {
  id: string;
  name?: string;
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  status?: string;
}

export interface PairTarget {
  id: string;
  name: string;
}

export interface PresenceMessage {
  version: 2;
  type: "presence";
  nonce: string;
}

export interface DiscoverMessage {
  version: 2;
  type: "discover";
  requestId: string;
}

export interface AssignmentMessage {
  version: 2;
  type: "assign";
  assignmentId: string;
  coordinatorId: string;
  project: string;
  issue: string;
  developerId: string;
  reviewerId: string;
}

export interface AcknowledgementMessage {
  version: 2;
  type: "ack";
  assignmentId: string;
  ok: boolean;
  name?: string;
  detail?: string;
}

export type PairMessage = PresenceMessage | DiscoverMessage | AssignmentMessage | AcknowledgementMessage;

export function normalizeIssueNumber(input: string): string {
  const match = input.trim().match(/^#?([0-9]+)$/);
  if (!match) throw new Error("Issue number must contain only digits, optionally prefixed with #.");
  const issue = BigInt(match[1]!);
  if (issue < 1n) throw new Error("Issue number must be greater than zero.");
  return issue.toString();
}

export function projectName(cwd: string): string {
  return basename(resolve(cwd)) || "project";
}

export function targetNames(project: string, issue: string): { developer: string; reviewer: string } {
  const name = project.trim();
  if (!name) throw new Error("Project name is required.");
  return { developer: `${name}-${issue}`, reviewer: `${name}-${issue}-review` };
}

export function assignmentId(project: string, issue: string, developerId: string, reviewerId: string): string {
  return JSON.stringify([2, project, issue, developerId, reviewerId]);
}

export function candidateSessions(
  sessions: LiveSession[],
  capableSessionIds: ReadonlySet<string>,
  currentSessionId: string,
): LiveSession[] {
  return sessions
    .filter((session) => session.id !== currentSessionId && capableSessionIds.has(session.id))
    .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
}

export function findNameConflict(sessions: LiveSession[], name: string, allowedSessionId: string): LiveSession | undefined {
  const expected = name.toLowerCase();
  return sessions.find((session) => session.id !== allowedSessionId && session.name?.toLowerCase() === expected);
}

export function formatCandidate(session: LiveSession): string {
  const name = session.name || "Unnamed session";
  const status = session.status ? ` · ${session.status}` : "";
  return `${name} — ${session.cwd} · ${session.model}${status} [${session.id}]`;
}

export function developerPrompt(project: string, issue: string, reviewer: PairTarget): string {
  return [
    `You are the developer for issue #${issue} in project ${project}.`,
    `Your reviewer is ${reviewer.name} (exact intercom session ID ${reviewer.id}).`,
    "Work only on the issue scope. Trace affected callers, implement the root fix, and run the relevant checks.",
    "When the candidate is committed and checked, request review with " +
      `intercom({ action: "ask", to: ${JSON.stringify(reviewer.id)}, message: "Review candidate <full SHA>. Base: <base SHA>. Checks: <commands/results>. Workspace artifacts: <paths/digests>." }).`,
    "If the sessions use separate worktrees, provide a pushed revision, forge diff, or shared workspace path that lets the reviewer inspect the exact candidate rather than their local branch.",
    "Verify each finding, fix valid findings, rerun affected checks, and request review again. Finish only after the reviewer explicitly reports no findings or requests a human decision; silence and timeouts are not approval.",
  ].join("\n\n");
}

export function reviewerPrompt(project: string, issue: string, developer: PairTarget): string {
  return [
    `You are the read-only reviewer for issue #${issue} in project ${project}.`,
    `The developer is ${developer.name} (exact intercom session ID ${developer.id}).`,
    "Wait for the developer's review request, then inspect the exact candidate revision or shared workspace artifact it identifies. Do not assume your local worktree contains the candidate.",
    "Review the full diff and affected callers for correctness, regressions, security, missing validation, and unrequested scope. Do not modify the implementation.",
    "Return findings ordered by severity with exact file and line evidence. Reply through the active intercom path with `intercom({ action: \"reply\", message: \"...\" })`.",
    "After repairs, review the new candidate again. When nothing remains, reply explicitly with `No findings.`; request a human decision when the issue cannot be resolved from the settled scope.",
  ].join("\n\n");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parsePairMessage(value: unknown): PairMessage | undefined {
  const record = object(value);
  if (!record || record.version !== 2) return undefined;
  const type = record.type;

  if (type === "presence") {
    const nonce = text(record, "nonce");
    return nonce ? { version: 2, type, nonce } : undefined;
  }

  if (type === "discover") {
    const requestId = text(record, "requestId");
    return requestId ? { version: 2, type, requestId } : undefined;
  }

  if (type === "assign") {
    const assignmentIdValue = text(record, "assignmentId");
    const coordinatorId = text(record, "coordinatorId");
    const project = text(record, "project");
    const issue = text(record, "issue");
    const developerId = text(record, "developerId");
    const reviewerId = text(record, "reviewerId");
    if (!assignmentIdValue || !coordinatorId || !project || !issue || !developerId || !reviewerId) return undefined;
    try {
      if (normalizeIssueNumber(issue) !== issue) return undefined;
    } catch {
      return undefined;
    }
    return {
      version: 2,
      type,
      assignmentId: assignmentIdValue,
      coordinatorId,
      project,
      issue,
      developerId,
      reviewerId,
    };
  }

  if (type === "ack") {
    const assignmentIdValue = text(record, "assignmentId");
    if (!assignmentIdValue || typeof record.ok !== "boolean") return undefined;
    const name = text(record, "name");
    const detail = text(record, "detail");
    return {
      version: 2,
      type,
      assignmentId: assignmentIdValue,
      ok: record.ok,
      ...(name ? { name } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  return undefined;
}
