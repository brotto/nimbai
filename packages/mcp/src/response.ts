import type { CallToolResult } from '@modelcontextprotocol/server';
import { SafetyNotice, type Attribution } from '@nimbai/core';

/**
 * Hard ceiling on a single tool response. Claude Code caps tool output at
 * ~25k tokens, so staying well under it is what keeps a result usable rather
 * than truncated by the client. Images are referenced by URL, never inlined
 * as base64 by this server: a thumbnail URL costs ~50 tokens, the same image
 * inline costs thousands, and several clients (Codex, VS Code) do not render
 * inline images at all.
 */
const MAX_TEXT_CHARS = 60_000;

export interface ToolPayload {
  /** Machine-readable result, mirrored into text for clients without structured support. */
  data: Record<string, unknown>;
  /** One short human sentence that leads the text mirror. */
  summary: string;
  attributions: Attribution[];
  /** Set when the result concerns severe weather, lightning or alerts. */
  safetyNotice?: boolean;
}

/**
 * The SDK's own result type. Declaring our own shape would compile against
 * `InputRequiredResult` instead and fail: the callback returns a union.
 */
export type ToolResult = CallToolResult;

function dedupeAttributions(list: Attribution[]): Attribution[] {
  const seen = new Map<string, Attribution>();
  for (const a of list) if (!seen.has(a.source)) seen.set(a.source, a);
  return [...seen.values()];
}

export function ok(payload: ToolPayload): ToolResult {
  const attributions = dedupeAttributions(payload.attributions);
  const structured: Record<string, unknown> = {
    ...payload.data,
    attribution: attributions,
  };
  if (payload.safetyNotice === true) structured.safety_notice = SafetyNotice;

  const tail: string[] = [];
  if (attributions.length > 0) {
    tail.push(
      '',
      `Attribution (must be shown to the user): ${attributions.map((a) => a.text).join(' · ')}`,
    );
  }
  if (payload.safetyNotice === true) tail.push('', SafetyNotice);
  const tailText = tail.join('\n');

  // The attribution and the safety notice are the two things that must never
  // be dropped, so the body is trimmed to fit around them rather than the
  // whole string being cut at the end.
  const head = `${payload.summary}\n\n`;
  const budget = MAX_TEXT_CHARS - head.length - tailText.length;
  const NOTE =
    '\n…[body truncated: narrow the bbox, time range or frame count. The structured result is complete.]';
  let body = JSON.stringify(structured, null, 2);
  if (budget <= 0) {
    // Head plus tail already fill the budget. The body is dropped entirely so
    // the attribution and the safety notice survive; they are the parts that
    // must reach the user.
    body = NOTE.trimStart();
  } else if (body.length > budget) {
    body = `${body.slice(0, Math.max(0, budget - NOTE.length))}${NOTE}`;
  }
  return {
    content: [{ type: 'text', text: `${head}${body}${tailText}` }],
    structuredContent: structured,
  };
}

/**
 * An error a model can act on. `nextSteps` is not decoration: without it the
 * model retries the same failing call.
 */
export function fail(message: string, nextSteps: string): ToolResult {
  const data = { error: message, next_steps: nextSteps };
  return {
    content: [{ type: 'text', text: `${message}\n\nNext steps: ${nextSteps}` }],
    structuredContent: data,
    isError: true,
  };
}
