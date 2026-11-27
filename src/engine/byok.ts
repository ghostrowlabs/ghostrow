import type { SchemaModel } from "../connect/types.js";
import { awsCredentials, awsRegion, signV4 } from "./aws.js";
import { googleAuth } from "./google.js";
import type { Plan } from "./infer.js";
import { compatible, MEANINGS, type MeaningId } from "./meanings.js";

/**
 * Bring your own AI key (Pro, Max). Off by default. Turn it on with GHOSTROW_AI_PROVIDER:
 *   anthropic  ANTHROPIC_API_KEY
 *   openai     OPENAI_API_KEY
 *   gemini     GEMINI_API_KEY
 *   bedrock    Amazon Bedrock (Converse API). AWS_REGION; credentials from the standard AWS chain
 *              (env, AWS_PROFILE, SSO, container, instance role) or AWS_BEARER_TOKEN_BEDROCK
 *   vertex     Google Vertex AI (Gemini). GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION (default global);
 *              Application Default Credentials or GOOGLE_OAUTH_ACCESS_TOKEN
 *   azure      Azure OpenAI. AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY
 *              (or AZURE_OPENAI_AD_TOKEN), AZURE_OPENAI_API_VERSION
 * GHOSTROW_AI_MODEL picks the model (on Azure, the deployment).
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

export const PROVIDER_IDS = ["anthropic", "openai", "gemini", "bedrock", "vertex", "azure"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ByokConfig =
  | { provider: "anthropic" | "openai" | "gemini"; model: string; key: string }
  | { provider: "bedrock"; model: string; region: string; bearer?: string }
  | { provider: "vertex"; model: string; project?: string; location: string; token?: string }
  | { provider: "azure"; model: string; endpoint: string; apiVersion: string; key?: string; adToken?: string };

const KEYED = {
  anthropic: { env: "ANTHROPIC_API_KEY", model: "claude-haiku-5-5" },
  openai: { env: "OPENAI_API_KEY", model: "gpt-5-mini" },
  gemini: { env: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
} as const;

export const AZURE_API_VERSION = "2024-10-21";

/** Amazon Nova Lite through the cross-Region inference profile for the region's geography. */
export function bedrockDefaultModel(region: string): string {
  const geo = region.startsWith("us-") ? "us." : region.startsWith("eu-") ? "eu." : region.startsWith("ap-") ? "apac." : "";
  return `${geo}amazon.nova-lite-v1:0`;
}

export function byokConfig(): ByokConfig | null {
  const env = process.env;
  const p = env.GHOSTROW_AI_PROVIDER?.trim().toLowerCase() as ProviderId | undefined;
  if (!p) return null;
  if (!(PROVIDER_IDS as readonly string[]).includes(p)) {
    throw new Error(`GHOSTROW_AI_PROVIDER must be one of ${PROVIDER_IDS.join(", ")}; got "${p}".`);
  }
  const model = env.GHOSTROW_AI_MODEL?.trim() || undefined;
  if (p === "anthropic" || p === "openai" || p === "gemini") {
    const key = env[KEYED[p].env];
    if (!key) throw new Error(`GHOSTROW_AI_PROVIDER=${p} needs ${KEYED[p].env} to be set.`);
    return { provider: p, key, model: model ?? KEYED[p].model };
  }
  if (p === "bedrock") {
    const region = awsRegion();
    if (!region) throw new Error("GHOSTROW_AI_PROVIDER=bedrock needs AWS_REGION (or a region in your AWS profile).");
    return { provider: p, region, model: model ?? bedrockDefaultModel(region), bearer: env.AWS_BEARER_TOKEN_BEDROCK || undefined };
  }
  if (p === "vertex") {
    return {
      provider: p,
      project: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || undefined,
      location: env.GOOGLE_CLOUD_LOCATION || env.GOOGLE_CLOUD_REGION || "global",
      model: model ?? "gemini-2.5-flash",
      token: env.GOOGLE_OAUTH_ACCESS_TOKEN || undefined,
    };
  }
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim().replace(/\/+$/, "").replace(/\/openai$/, "");
  if (!endpoint) throw new Error("GHOSTROW_AI_PROVIDER=azure needs AZURE_OPENAI_ENDPOINT (https://<resource>.openai.azure.com).");
  const deployment = model ?? env.AZURE_OPENAI_DEPLOYMENT?.trim();
  if (!deployment) throw new Error("GHOSTROW_AI_PROVIDER=azure needs AZURE_OPENAI_DEPLOYMENT (or GHOSTROW_AI_MODEL) set to your deployment name.");
  const key = env.AZURE_OPENAI_API_KEY || undefined;
  const adToken = env.AZURE_OPENAI_AD_TOKEN || undefined;
  if (!key && !adToken) throw new Error("GHOSTROW_AI_PROVIDER=azure needs AZURE_OPENAI_API_KEY (or a Microsoft Entra token in AZURE_OPENAI_AD_TOKEN).");
  return { provider: p, endpoint, model: deployment, apiVersion: env.AZURE_OPENAI_API_VERSION || env.OPENAI_API_VERSION || AZURE_API_VERSION, key, adToken };
}

const THRESHOLD = 0.6;

export async function refineWithByok(plan: Plan, schema: SchemaModel, cfg: ByokConfig): Promise<ByokResult> {
  const unsure = plan.columns.filter((c) => !c.pinned && c.meaning !== "reference" && c.confidence < THRESHOLD);
  const result: ByokResult = { provider: cfg.provider, model: cfg.model, asked: unsure.length, changed: 0 };
  if (unsure.length === 0) return result;
  const ask = await connect(cfg);
  for (let i = 0; i < unsure.length; i += 80) {
    const batch = unsure.slice(i, i + 80);
    const lines = batch.map((c) => {
      const col = schema.tables.find((t) => t.name === c.table)!.columns.find((x) => x.name === c.column)!;
      return `${c.table}.${c.column}: ${col.rawType || col.type}`;
    });
    const prompt = `Label what each database column holds, for generating realistic synthetic test data.\nAllowed labels: ${MEANINGS.join(", ")}.\nAnswer with only a JSON object mapping "table.column" to a label.\n\n${lines.join("\n")}`;
    const answer = await ask(prompt);
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

type Ask = (prompt: string) => Promise<string>;

async function post(name: string, url: string, headers: Record<string, string>, body: string): Promise<unknown> {
  const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${name} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

type ChatCompletion = { choices?: { message?: { content?: string } }[] };
type GeminiResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };
const geminiText = (j: GeminiResponse) => j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
const geminiBody = (prompt: string) => JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } });
const JSON_HEADERS = { "content-type": "application/json" };

/** Resolves credentials once, then returns a function that sends one prompt and returns the text answer. */
export async function connect(cfg: ByokConfig): Promise<Ask> {
  switch (cfg.provider) {
    case "anthropic":
      return async (prompt) => {
        const j = (await post(
          "Anthropic API",
          "https://api.anthropic.com/v1/messages",
          { ...JSON_HEADERS, "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
          JSON.stringify({ model: cfg.model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
        )) as { content?: { type: string; text?: string }[] };
        return j.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
      };
    case "openai":
      return async (prompt) => {
        const j = (await post(
          "OpenAI API",
          "https://api.openai.com/v1/chat/completions",
          { ...JSON_HEADERS, authorization: `Bearer ${cfg.key}` },
          JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
        )) as ChatCompletion;
        return j.choices?.[0]?.message?.content ?? "";
      };
    case "gemini":
      return async (prompt) =>
        geminiText(
          (await post(
            "Gemini API",
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
            { ...JSON_HEADERS, "x-goog-api-key": cfg.key },
            geminiBody(prompt),
          )) as GeminiResponse,
        );
    case "bedrock": {
      const url = `https://bedrock-runtime.${cfg.region}.amazonaws.com/model/${encodeURIComponent(cfg.model)}/converse`;
      const creds = cfg.bearer ? null : await awsCredentials(cfg.region);
      return async (prompt) => {
        const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: prompt }] }], inferenceConfig: { maxTokens: 4096 } });
        const headers = creds
          ? signV4({ method: "POST", url, headers: { ...JSON_HEADERS }, body }, creds, cfg.region, "bedrock")
          : { ...JSON_HEADERS, authorization: `Bearer ${cfg.bearer}` };
        const j = (await post("Amazon Bedrock", url, headers, body)) as { output?: { message?: { content?: { text?: string }[] } } };
        return j.output?.message?.content?.map((b) => b.text ?? "").join("") ?? "";
      };
    }
    case "vertex": {
      const auth = cfg.token ? { token: cfg.token, project: undefined } : await googleAuth();
      const project = cfg.project ?? auth.project;
      if (!project) throw new Error("GHOSTROW_AI_PROVIDER=vertex needs GOOGLE_CLOUD_PROJECT.");
      const host = cfg.location === "global" ? "aiplatform.googleapis.com" : `${cfg.location}-aiplatform.googleapis.com`;
      const url = `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(cfg.location)}/publishers/google/models/${encodeURIComponent(cfg.model)}:generateContent`;
      return async (prompt) => geminiText((await post("Vertex AI", url, { ...JSON_HEADERS, authorization: `Bearer ${auth.token}` }, geminiBody(prompt))) as GeminiResponse);
    }
    case "azure": {
      const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.model)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`;
      const auth: Record<string, string> = cfg.key ? { "api-key": cfg.key } : { authorization: `Bearer ${cfg.adToken}` };
      return async (prompt) => {
        const j = (await post(
          "Azure OpenAI",
          url,
          { ...JSON_HEADERS, ...auth },
          JSON.stringify({ messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
        )) as ChatCompletion;
        return j.choices?.[0]?.message?.content ?? "";
      };
    }
  }
}
