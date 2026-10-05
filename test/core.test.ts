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
  processMarker,
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

test("treats a declared pull request as part of the assignment identity", () => {
  const base = assignmentId("billing", "710", "developer-id", "reviewer-id");
  assert.equal(
    assignmentId("billing", "710", "developer-id", "reviewer-id", "1234"),
    assignmentId("billing", "710", "developer-id", "reviewer-id", "1234"),
  );
  assert.notEqual(assignmentId("billing", "710", "developer-id", "reviewer-id", "1234"), base);
  assert.notEqual(
    assignmentId("billing", "710", "developer-id", "reviewer-id", "1234"),
    assignmentId("billing", "710", "developer-id", "reviewer-id", "5678"),
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
  assert.ok(developer.includes(processMarker("developer")));

  const reviewer = reviewerPrompt("billing", "710", { id: "developer-id", name: "billing-710" });
  assert.match(reviewer, /read-only reviewer/);
  assert.match(reviewer, /exact candidate revision/);
  assert.match(reviewer, /action: "reply"/);
  assert.match(reviewer, /action: "send", to: "developer-id"/);
  assert.match(reviewer, /No findings\./);
  assert.ok(reviewer.includes(processMarker("reviewer")));
  assert.notEqual(processMarker("developer"), processMarker("reviewer"));

  const continuedDeveloper = developerPrompt("billing", "710", { id: "reviewer-id", name: "billing-710-review" }, { pullRequest: "1234" });
  assert.match(continuedDeveloper, /continuation of an existing pair review on pull request 1234/);
  assert.match(continuedDeveloper, /answer each previous finding/);
  assert.doesNotMatch(developer, /continuation of an existing pair review/);

  const continuedReviewer = reviewerPrompt("billing", "710", { id: "developer-id", name: "billing-710" }, { pullRequest: "1234" });
  assert.match(continuedReviewer, /continuation of an existing pair review on pull request 1234/);
  assert.match(continuedReviewer, /judge the new candidate against the open findings and the delta/);
  assert.doesNotMatch(reviewer, /continuation of an existing pair review/);
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

  const assigned = parsePairMessage({
    version: 2,
    type: "assign",
    assignmentId: "x",
    coordinatorId: "one",
    project: "billing",
    issue: "710",
    developerId: "two",
    reviewerId: "three",
    pullRequest: "1234",
  });
  assert.equal(assigned?.type, "assign");
  assert.equal(assigned && "pullRequest" in assigned ? assigned.pullRequest : undefined, "1234");
});
