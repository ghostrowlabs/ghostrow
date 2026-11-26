import type { RunContext } from "./context.js";

/** Print a result: human text, or one JSON document with --json. --quiet prints nothing on success. */
export function out(ctx: RunContext, r: { text: string; json: unknown }): void {
  if (ctx.json) process.stdout.write(`${JSON.stringify(r.json, null, 2)}\n`);
  else if (!ctx.quiet) process.stdout.write(`${r.text}\n`);
}

/** Progress and notices go to stderr, so stdout stays clean for --json and pipes. */
export function note(ctx: RunContext, msg: string): void {
  if (!ctx.quiet) process.stderr.write(`${msg}\n`);
}

export const fmt = (n: number) => n.toLocaleString("en-US");

/** Notices that change what a run does (a plan fallback, a skipped feature): printed to stderr even with --quiet. */
export function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
