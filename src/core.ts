import { randomInt } from "node:crypto";

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
  pullRequest?: string;
}

// A declared pull request marks an in-progress review: both roles read the
// existing comments and open findings instead of starting the issue over.
export interface ReviewContext {
  pullRequest?: string;
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

export const FALLBACK_PROJECT_NAMES = [
  "amber", "apple", "atlas", "badger", "bamboo", "beacon", "birch", "blue", "brook", "cedar",
  "cherry", "cloud", "coral", "crane", "dawn", "delta", "ember", "falcon", "fern", "field",
  "finch", "forest", "fox", "frost", "garden", "grove", "harbor", "hazel", "hill", "iris",
  "island", "jade", "lake", "maple", "meadow", "moon", "oak", "ocean", "olive", "otter",
  "pine", "river", "robin", "sage", "sky", "stone", "sun", "swift", "willow", "wind",
] as const;

export function randomProjectName(): string {
  return FALLBACK_PROJECT_NAMES[randomInt(FALLBACK_PROJECT_NAMES.length)]!;
}

export function targetNames(project: string, issue: string): { developer: string; reviewer: string } {
  const name = project.trim();
  if (!name) throw new Error("Project name is required.");
  return { developer: `${name}-${issue}`, reviewer: `${name}-${issue}-review` };
}

export function assignmentId(
  project: string,
  issue: string,
  developerId: string,
  reviewerId: string,
  pullRequest?: string,
): string {
  return JSON.stringify([2, project, issue, developerId, reviewerId, pullRequest ?? null]);
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

// The picker spends these rows on its title, spacers, footer, and scroll counter.
const PICKER_CHROME_ROWS = 6;

export function candidateLabel(session: LiveSession): string {
  return session.name || `Unnamed ${session.id.slice(0, 8)}`;
}

export function candidateDescription(session: LiveSession): string {
  const segments = session.cwd.split("/").filter(Boolean);
  const cwd = segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : session.cwd;
  return [cwd, session.model, session.status, `id ${session.id.slice(0, 8)}`].filter(Boolean).join(" · ");
}

export function visibleCandidateRows(terminalRows: number, candidates: number): number {
  return Math.max(1, Math.min(candidates, terminalRows - PICKER_CHROME_ROWS));
}

export function formatCandidate(session: LiveSession): string {
  const name = session.name || "Unnamed session";
  const status = session.status ? ` · ${session.status}` : "";
  return `${name} — ${session.cwd} · ${session.model}${status} [${session.id}]`;
}

export type PairRole = "developer" | "reviewer";

// Integration hook: routing layers can match these non-typable markers to drive
// repository-specific process, for example loading a work-issue or review skill.
export function processMarker(role: PairRole): string {
  return `⟦pi-intercom-review-pair:${role}⟧`;
}

function continuationBrief(role: PairRole, pullRequest: string): string {
  const where = `pull request ${pullRequest}`;
  return role === "developer"
    ? `This is a continuation of an existing pair review on ${where}. Do not restart the issue from scratch: read the current branch, the existing review comments, and every open finding first, then answer each previous finding in your next candidate.`
    : `This is a continuation of an existing pair review on ${where}. Do not re-review the issue from scratch: read the existing review comments first, then judge the new candidate against the open findings and the delta.`;
}

export function developerPrompt(
  project: string,
  issue: string,
  reviewer: PairTarget,
  context: ReviewContext = {},
): string {
  return [
    `You are the developer for issue #${issue} in project ${project}.`,
    `Your reviewer is ${reviewer.name} (exact intercom session ID ${reviewer.id}).`,
    ...(context.pullRequest ? [continuationBrief("developer", context.pullRequest)] : []),
    "Work only on the issue scope. Trace affected callers, implement the root fix, and run the relevant checks.",
    "When the candidate is committed and checked, request review. When the work has a pull request, post the candidate details there first (full SHA, base SHA, checks with commands and results, workspace artifact paths and digests, and your response to each previous finding), then ask with only the SHA and that comment's URL: " +
      `intercom({ action: "ask", to: ${JSON.stringify(reviewer.id)}, message: "Review candidate <full SHA>: <comment URL>" }).`,
    "Without a pull request, the ask carries the details itself: " +
      `intercom({ action: "ask", to: ${JSON.stringify(reviewer.id)}, message: "Review candidate <full SHA>. Base: <base SHA>. Checks: <commands/results>. Workspace artifacts: <paths/digests>." }).`,
    "With a pull request, intercom carries only pointers and the pull request is the published record: when the reviewer's message links a comment, read the findings there.",
    processMarker("developer"),
    "If the sessions use separate worktrees, provide a pushed revision, forge diff, or shared workspace path that lets the reviewer inspect the exact candidate rather than their local branch.",
    "Send the review ask from this session, never from a subagent. If an ask is cancelled or times out, the reviewer may still deliver its result as a normal intercom message; treat that message as the reply and do not ask again for the same candidate.",
    "Verify each finding, fix valid findings, rerun affected checks, and request review again. Finish only after the reviewer explicitly reports no findings or requests a human decision; silence and timeouts are not approval.",
  ].join("\n\n");
}

export function reviewerPrompt(
  project: string,
  issue: string,
  developer: PairTarget,
  context: ReviewContext = {},
): string {
  return [
    `You are the read-only reviewer for issue #${issue} in project ${project}.`,
    `The developer is ${developer.name} (exact intercom session ID ${developer.id}).`,
    ...(context.pullRequest ? [continuationBrief("reviewer", context.pullRequest)] : []),
    "Wait for the developer's review request, then inspect the exact candidate revision or shared workspace artifact it identifies. Do not assume your local worktree contains the candidate.",
    "Review the full diff and affected callers for correctness, regressions, security, missing validation, and unrequested scope. Do not modify the implementation.",
    "Write findings ordered by severity with exact file and line evidence. When the candidate has a pull request, post them on the pull request the review request links through this repository's standard review process (when the request omits one, locate it the usual way), then reply with only the verdict and that comment's URL, for example `REJECT: <comment URL>`. Without a pull request, the reply carries the findings themselves.",
    "Reply through the active intercom path with `intercom({ action: \"reply\", message: \"...\" })`. If the reply is not delivered, the developer's ask is no longer open. Send the same message with " +
      `intercom({ action: "send", to: ${JSON.stringify(developer.id)}, message: "..." }) instead; never drop findings.`,
    processMarker("reviewer"),
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
    const pullRequest = text(record, "pullRequest");
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
      ...(pullRequest ? { pullRequest } : {}),
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
