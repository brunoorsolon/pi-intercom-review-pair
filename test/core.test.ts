import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentId,
  candidateSessions,
  developerPrompt,
  FALLBACK_PROJECT_NAMES,
  findNameConflict,
  formatCandidate,
  normalizeIssueNumber,
  parsePairMessage,
  randomProjectName,
  reviewerPrompt,
  targetNames,
  type LiveSession,
} from "../src/core.ts";

test("normalizes numeric issue input and rejects invalid values", () => {
  assert.equal(normalizeIssueNumber("42"), "42");
  assert.equal(normalizeIssueNumber(" #0042 "), "42");
  for (const value of ["", "#", "0", "-1", "1.5", "issue-42", "# 42"]) {
    assert.throws(() => normalizeIssueNumber(value));
  }
});

test("builds names from explicit or random project names", () => {
  assert.equal(FALLBACK_PROJECT_NAMES.length, 50);
  assert.ok(FALLBACK_PROJECT_NAMES.includes(randomProjectName()));
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

test("offers every capable peer and excludes the invoking session", () => {
  const sessions: LiveSession[] = [
    { id: "current", runtimeFallbackAlias: true, cwd: "/repo", model: "gpt" },
    { id: "named", name: "ready", cwd: "/repo", model: "gpt" },
    { id: "unnamed", runtimeFallbackAlias: true, cwd: "/other", model: "claude" },
    { id: "without-extension", name: "other", cwd: "/repo", model: "gpt" },
  ];
  const capable = new Set(["current", "named", "unnamed"]);

  assert.deepEqual(
    candidateSessions(sessions, capable, "current").map((session) => session.id),
    ["named", "unnamed"],
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

test("formats candidates with location and runtime details", () => {
  const formatted = formatCandidate({
    id: "session-id",
    cwd: "/work/billing",
    model: "gpt-5",
    status: "idle",
  });
  assert.equal(formatted, "Unnamed session — /work/billing · gpt-5 · idle [session-id]");
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
    version: 2,
    type: "presence",
    nonce: "nonce",
  }), {
    version: 2,
    type: "presence",
    nonce: "nonce",
  });
  assert.equal(parsePairMessage({ version: 1, type: "presence", nonce: "nonce" }), undefined);
  assert.equal(parsePairMessage({
    version: 2,
    type: "assign",
    assignmentId: "x",
    coordinatorId: "one",
    project: "billing",
    issue: "not-a-number",
    developerId: "two",
    reviewerId: "three",
  }), undefined);
  assert.equal(parsePairMessage({ version: 2, type: "ack", assignmentId: "x", ok: "yes" }), undefined);
  assert.equal(parsePairMessage(["not", "an", "object"]), undefined);
});
