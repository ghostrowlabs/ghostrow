import type { SchemaModel } from "../connect/types.js";
import type { Plan } from "./infer.js";
import { compatible, MEANINGS, type MeaningId } from "./meanings.js";

/**
 * Bring your own AI key (Pro, Max). Off by default. Turn it on with
 *   GHOSTROW_AI_PROVIDER=anthropic|openai|gemini  and that provider's usual key variable
 *   (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY); GHOSTROW_AI_MODEL picks the model.
 * Only schema text is sent — table names, column names and types for the columns the
 * built-in engine was least sure about. Never rows, samples or code. Answers are checked
 * against the column type, and every change is marked in ghostrow.rules.yaml.
 */

export interface ByokResult {
  provider: string;
  model: string;
  asked: number;
  changed: number;
}

const PROVIDERS = {
  anthropic: { env: "ANTHROPIC_API_KEY", model: "claude-haiku-5-5" },
  openai: { env: "OPENAI_API_KEY", model: "gpt-5-mini" },
  gemini: { env: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
} as const;

export function byokConfig(): { provider: keyof typeof PROVIDERS; key: string; model: string } | null {
  const p = process.env.GHOSTROW_AI_PROVIDER?.toLowerCase() as keyof typeof PROVIDERS | undefined;
  if (!p) return null;
  if (!(p in PROVIDERS)) throw new Error(`GHOSTROW_AI_PROVIDER must be anthropic, openai or gemini; got "${p}".`);
  const key = process.env[PROVIDERS[p].env];
  if (!key) throw new Error(`GHOSTROW_AI_PROVIDER=${p} needs ${PROVIDERS[p].env} to be set.`);
  return { provider: p, key, model: process.env.GHOSTROW_AI_MODEL ?? PROVIDERS[p].model };
}

const THRESHOLD = 0.6;

export async function refineWithByok(plan: Plan, schema: SchemaModel, cfg: NonNullable<ReturnType<typeof byokConfig>>): Promise<ByokResult> {
  const unsure = plan.columns.filter((c) => !c.pinned && c.meaning !== "reference" && c.confidence < THRESHOLD);
  const result: ByokResult = { provider: cfg.provider, model: cfg.model, asked: unsure.length, changed: 0 };
  for (let i = 0; i < unsure.length; i += 80) {
    const batch = unsure.slice(i, i + 80);
    const lines = batch.map((c) => {
      const col = schema.tables.find((t) => t.name === c.table)!.columns.find((x) => x.name === c.column)!;
      return `${c.table}.${c.column}: ${col.rawType || col.type}`;
    });
    const prompt = `Label what each database column holds, for generating realistic synthetic test data.\nAllowed labels: ${MEANINGS.join(", ")}.\nAnswer with only a JSON object mapping "table.column" to a label.\n\n${lines.join("\n")}`;
    const answer = await ask(cfg, prompt);
    const json = /\{[\s\S]*\}/.exec(answer)?.[0];
    if (!json) continue;
    let map: Record<string, string>;
    try {
      map = JSON.parse(json) as Record<string, string>;
    } catch {
      continue;
    }
    for (const c of batch) {
      const label = map[`${c.table}.${c.column}`];
      const col = schema.tables.find((t) => t.name === c.table)!.columns.find((x) => x.name === c.column)!;
      if (!label || !(MEANINGS as readonly string[]).includes(label) || label === c.meaning || !compatible(label as MeaningId, col)) continue;
      c.meaning = label as MeaningId;
      c.evidence = `your AI provider (${cfg.provider})`;
      c.confidence = Math.max(c.confidence, 0.7);
      result.changed++;
    }
  }
  return result;
}

async function ask(cfg: NonNullable<ReturnType<typeof byokConfig>>, prompt: string): Promise<string> {
  const signal = AbortSignal.timeout(60_000);
  if (cfg.provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
      signal,
    });
    if (!r.ok) throw new Error(`Anthropic API answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    return j.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
  }
  if (cfg.provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
      signal,
    });
    if (!r.ok) throw new Error(`OpenAI API answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": cfg.key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
    signal,
  });
  if (!r.ok) throw new Error(`Gemini API answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}
