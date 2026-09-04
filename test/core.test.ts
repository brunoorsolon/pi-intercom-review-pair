import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentId,
  candidateSessions,
  developerPrompt,
  findNameConflict,
  normalizeIssueNumber,
  parsePairMessage,
  reviewerPrompt,
  roleFromActorIdentity,
  targetNames,
  type LiveSession,
  type PeerMetadata,
} from "../src/core.ts";

test("normalizes numeric issue input and rejects invalid values", () => {
  assert.equal(normalizeIssueNumber("42"), "42");
  assert.equal(normalizeIssueNumber(" #0042 "), "42");
  for (const value of ["", "#", "0", "-1", "1.5", "issue-42", "# 42"]) {
    assert.throws(() => normalizeIssueNumber(value));
  }
});

test("derives roles only from Actor Identity metadata", () => {
  assert.equal(roleFromActorIdentity("gpt"), "base");
  assert.equal(roleFromActorIdentity("gpt-reviewer"), "reviewer");
  assert.equal(roleFromActorIdentity("  legion-reviewer  "), "reviewer");
  assert.equal(roleFromActorIdentity(""), undefined);
});

test("uses the required names and a deterministic assignment identity", () => {
  assert.deepEqual(targetNames("billing", "710"), {
    developer: "billing-710",
    reviewer: "billing-710-review",
  });
  assert.equal(
    assignmentId("billing", "710", "developer-id", "reviewer-id"),
    assignmentId("billing", "710", "developer-id", "reviewer-id"),
  );
  assert.notEqual(
    assignmentId("billing", "710", "developer-id", "reviewer-id"),
    assignmentId("billing", "710", "developer-id", "other-reviewer"),
  );
});

test("filters by project and role while hiding unnamed fallback peers", () => {
  const sessions: LiveSession[] = [
    { id: "current", runtimeFallbackAlias: true, cwd: "/repo", model: "gpt" },
    { id: "named", name: "ready", cwd: "/repo", model: "gpt" },
    { id: "hidden", runtimeFallbackAlias: true, cwd: "/repo", model: "gpt" },
    { id: "unnamed", cwd: "/repo", model: "gpt" },
    { id: "other-project", name: "other", cwd: "/repo", model: "gpt" },
  ];
  const metadata = new Map<string, PeerMetadata>([
    ["current", { project: "billing", actorIdentity: "gpt", role: "base" }],
    ["named", { project: "billing", actorIdentity: "legion", role: "base" }],
    ["hidden", { project: "billing", actorIdentity: "oracle", role: "base" }],
    ["unnamed", { project: "billing", actorIdentity: "claude", role: "base" }],
    ["other-project", { project: "catalog", actorIdentity: "gpt", role: "base" }],
  ]);

  assert.deepEqual(
    candidateSessions(sessions, metadata, "billing", "base", false, "current").map(({ session }) => session.id),
    ["current", "named"],
  );
  assert.deepEqual(
    candidateSessions(sessions, metadata, "billing", "base", true, "current").map(({ session }) => session.id),
    ["current", "hidden", "named", "unnamed"],
  );
});

test("detects duplicate names case-insensitively except on the selected target", () => {
  const sessions: LiveSession[] = [
    { id: "one", name: "billing-710", cwd: "/repo", model: "gpt" },
    { id: "two", name: "other", cwd: "/repo", model: "gpt" },
  ];
  assert.equal(findNameConflict(sessions, "BILLING-710", "two")?.id, "one");
  assert.equal(findNameConflict(sessions, "billing-710", "one"), undefined);
});

test("role prompts pin exact peers and the repair-review loop", () => {
  const developer = developerPrompt("billing", "710", { id: "reviewer-id", name: "billing-710-review" });
  assert.match(developer, /to: "reviewer-id"/);
  assert.match(developer, /full SHA/);
  assert.match(developer, /fix valid findings/);
  assert.match(developer, /silence and timeouts are not approval/);

  const reviewer = reviewerPrompt("billing", "710", { id: "developer-id", name: "billing-710" });
  assert.match(reviewer, /read-only reviewer/);
  assert.match(reviewer, /exact candidate revision/);
  assert.match(reviewer, /action: "reply"/);
  assert.match(reviewer, /No findings\./);
});

test("parses only bounded protocol messages", () => {
  assert.deepEqual(parsePairMessage({
    version: 1,
    type: "presence",
    nonce: "nonce",
    project: "billing",
    actorIdentity: "gpt-reviewer",
    role: "reviewer",
  }), {
    version: 1,
    type: "presence",
    nonce: "nonce",
    project: "billing",
    actorIdentity: "gpt-reviewer",
    role: "reviewer",
  });
  assert.equal(parsePairMessage({ version: 2, type: "presence" }), undefined);
  assert.equal(parsePairMessage({
    version: 1,
    type: "assign",
    assignmentId: "x",
    coordinatorId: "one",
    project: "billing",
    issue: "not-a-number",
    developerId: "two",
    reviewerId: "three",
  }), undefined);
  assert.equal(parsePairMessage({ version: 1, type: "ack", project: "billing", assignmentId: "x", ok: "yes" }), undefined);
  assert.equal(parsePairMessage(["not", "an", "object"]), undefined);
});
