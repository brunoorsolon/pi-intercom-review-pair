import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item && typeof item === "object" && "text" in item ? String(item.text) : "")
    .join("\n");
}

function messageText(message: Record<string, unknown> | undefined): string {
  return message ? contentText(message.content) : "";
}

function assistantMessage(model: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function streamText(model: Record<string, unknown>, text: string) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = assistantMessage(model);
    stream.push({ type: "start", partial: output });
    const block = { type: "text", text };
    (output.content as unknown[]).push(block);
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
    output.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  });
  return stream;
}

function streamTool(model: Record<string, unknown>, name: string, args: Record<string, unknown>) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = assistantMessage(model);
    stream.push({ type: "start", partial: output });
    const toolCall = { type: "toolCall", id: randomUUID(), name, arguments: args };
    (output.content as unknown[]).push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    output.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
  });
  return stream;
}

export default function fakeReviewProvider(pi: { registerProvider(name: string, provider: Record<string, unknown>): void }): void {
  const actorIdentity = process.env.AI_AGENTS_SANDBOX_ACTOR_IDENTITY ?? "";
  pi.registerProvider("pair-smoke", {
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "unused",
    api: "pair-smoke-api",
    models: [{
      id: "pair-smoke-model",
      name: "Review Pair Smoke",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    }],
    streamSimple(model: Record<string, unknown>, context: { messages: Array<Record<string, unknown>> }) {
      const last = context.messages.at(-1);
      const lastText = messageText(last);
      const transcript = context.messages.map(messageText).join("\n");
      const reviewerId = transcript.match(/reviewer is .*\(exact intercom session ID ([^)]+)\)/)?.[1];

      if (!actorIdentity.endsWith("-reviewer") && last?.role === "user" && lastText.includes("BEGIN_FAKE_REVIEW_LOOP")) {
        if (!reviewerId) return streamText(model, "missing reviewer id");
        return streamTool(model, "intercom", { action: "ask", to: reviewerId, message: "FAKE_REVIEW_REQUEST_1" });
      }
      if (actorIdentity.endsWith("-reviewer") && last?.role === "user" && lastText.includes("FAKE_REVIEW_REQUEST_1")) {
        return streamTool(model, "intercom", { action: "reply", message: "FINDING: repair the fake regression" });
      }
      if (!actorIdentity.endsWith("-reviewer") && last?.role === "toolResult" && lastText.includes("FINDING:")) {
        if (!reviewerId) return streamText(model, "missing reviewer id");
        return streamTool(model, "intercom", { action: "ask", to: reviewerId, message: "FAKE_REVIEW_REQUEST_2 repaired" });
      }
      if (actorIdentity.endsWith("-reviewer") && last?.role === "user" && lastText.includes("FAKE_REVIEW_REQUEST_2")) {
        return streamTool(model, "intercom", { action: "reply", message: "No findings." });
      }
      if (!actorIdentity.endsWith("-reviewer") && last?.role === "toolResult" && lastText.includes("No findings.")) {
        return streamText(model, "repair-review-loop-complete");
      }
      return streamText(model, "pair-smoke-ready");
    },
  });
}
