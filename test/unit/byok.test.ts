import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { awsCredentials, signV4 } from "../../src/engine/aws.js";
import { AZURE_API_VERSION, bedrockDefaultModel, byokConfig, connect, refineWithByok, type ByokConfig } from "../../src/engine/byok.js";
import { googleAuth } from "../../src/engine/google.js";
import { infer } from "../../src/engine/infer.js";

// Every variable these code paths read. Cleared before each test so the developer's own cloud setup never leaks in.
const VARS = [
  "GHOSTROW_AI_PROVIDER", "GHOSTROW_AI_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_REGION", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "GCE_METADATA_HOST",
  "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_AD_TOKEN", "AZURE_OPENAI_API_VERSION", "OPENAI_API_VERSION",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ghostrow-byok-"));
  for (const v of VARS) vi.stubEnv(v, "");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("CLOUDSDK_CONFIG", join(dir, "gcloud"));
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(dir, "aws-credentials"));
  vi.stubEnv("AWS_CONFIG_FILE", join(dir, "aws-config"));
  vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Replaces fetch. `reply` gets each request and returns the JSON (or text) to answer with. */
function mockFetch(reply: (c: Call) => unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    const r = reply(call);
    return new Response(typeof r === "string" ? r : JSON.stringify(r), { status });
  });
  return calls;
}

const env = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
};

describe("byokConfig", () => {
  it("is off without GHOSTROW_AI_PROVIDER and rejects unknown providers", () => {
    expect(byokConfig()).toBeNull();
    env({ GHOSTROW_AI_PROVIDER: "watson" });
    expect(() => byokConfig()).toThrow(/anthropic, openai, gemini, bedrock, vertex, azure/);
  });

  it("bedrock: needs a region, defaults to Nova Lite for the region's geography, keeps the bearer key", () => {
    env({ GHOSTROW_AI_PROVIDER: "bedrock" });
    expect(() => byokConfig()).toThrow(/AWS_REGION/);
    env({ AWS_REGION: "eu-west-1", AWS_BEARER_TOKEN_BEDROCK: "bk" });
    expect(byokConfig()).toEqual({ provider: "bedrock", region: "eu-west-1", model: "eu.amazon.nova-lite-v1:0", bearer: "bk" });
    expect(bedrockDefaultModel("us-east-1")).toBe("us.amazon.nova-lite-v1:0");
    expect(bedrockDefaultModel("ap-southeast-2")).toBe("apac.amazon.nova-lite-v1:0");
    expect(bedrockDefaultModel("sa-east-1")).toBe("amazon.nova-lite-v1:0");
  });

  it("bedrock: reads the region from the AWS profile when the environment has none", () => {
    writeFileSync(join(dir, "aws-config"), "[profile work]\nregion = us-west-2\n");
    env({ GHOSTROW_AI_PROVIDER: "BEDROCK", AWS_PROFILE: "work", GHOSTROW_AI_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(byokConfig()).toMatchObject({ provider: "bedrock", region: "us-west-2", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
  });

  it("vertex: location defaults to global; project and token are optional at this point", () => {
    env({ GHOSTROW_AI_PROVIDER: "vertex" });
    expect(byokConfig()).toEqual({ provider: "vertex", project: undefined, location: "global", model: "gemini-2.5-flash", token: undefined });
    env({ GOOGLE_CLOUD_PROJECT: "p1", GOOGLE_CLOUD_LOCATION: "europe-west4", GOOGLE_OAUTH_ACCESS_TOKEN: "ya29" });
    expect(byokConfig()).toMatchObject({ project: "p1", location: "europe-west4", token: "ya29" });
  });

  it("azure: needs an endpoint, a deployment and a key or Entra token", () => {
    env({ GHOSTROW_AI_PROVIDER: "azure" });
    expect(() => byokConfig()).toThrow(/AZURE_OPENAI_ENDPOINT/);
    env({ AZURE_OPENAI_ENDPOINT: "https://acme.openai.azure.com/openai/" });
    expect(() => byokConfig()).toThrow(/AZURE_OPENAI_DEPLOYMENT/);
    env({ AZURE_OPENAI_DEPLOYMENT: "gpt-4o-mini" });
    expect(() => byokConfig()).toThrow(/AZURE_OPENAI_API_KEY/);
    env({ AZURE_OPENAI_API_KEY: "k" });
    expect(byokConfig()).toEqual({ provider: "azure", endpoint: "https://acme.openai.azure.com", model: "gpt-4o-mini", apiVersion: AZURE_API_VERSION, key: "k", adToken: undefined });
  });
});

const ANSWER = '{"t.a":"email"}';

describe("connect: request shapes", () => {
  it("anthropic, openai and gemini keep their existing requests", async () => {
    const calls = mockFetch((c) =>
      c.url.includes("anthropic") ? { content: [{ type: "text", text: ANSWER }] } : c.url.includes("openai") ? { choices: [{ message: { content: ANSWER } }] } : { candidates: [{ content: { parts: [{ text: ANSWER }] } }] },
    );
    for (const provider of ["anthropic", "openai", "gemini"] as const) {
      expect(await (await connect({ provider, key: "K", model: "m" }))("hi")).toBe(ANSWER);
    }
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.openai.com/v1/chat/completions",
      "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent",
    ]);
    expect(calls[0]!.headers["x-api-key"]).toBe("K");
    expect(calls[1]!.headers.authorization).toBe("Bearer K");
    expect(calls[2]!.headers["x-goog-api-key"]).toBe("K");
  });

  it("bedrock: signed Converse call with credentials from the environment", async () => {
    env({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "session" });
    const calls = mockFetch(() => ({ output: { message: { role: "assistant", content: [{ text: ANSWER }] } } }));
    const ask = await connect({ provider: "bedrock", region: "us-east-1", model: "us.amazon.nova-lite-v1:0" });
    expect(await ask("label these")).toBe(ANSWER);
    const c = calls[0]!;
    expect(c.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-lite-v1%3A0/converse");
    expect(JSON.parse(c.body)).toEqual({ messages: [{ role: "user", content: [{ text: "label these" }] }], inferenceConfig: { maxTokens: 4096 } });
    expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(c.headers["x-amz-security-token"]).toBe("session");
  });

  it("bedrock: a Bedrock API key is sent as a bearer token and skips the credential chain", async () => {
    const calls = mockFetch(() => ({ output: { message: { content: [{ text: ANSWER }] } } }));
    await (await connect({ provider: "bedrock", region: "us-west-2", model: "m", bearer: "ABSK123" }))("x");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer ABSK123");
  });

  it("bedrock: reports errors with the status", async () => {
    mockFetch(() => "AccessDeniedException", 403);
    const ask = await connect({ provider: "bedrock", region: "us-east-1", model: "m", bearer: "b" });
    await expect(ask("x")).rejects.toThrow("Amazon Bedrock answered 403: AccessDeniedException");
  });

  it("vertex: regional and global endpoints, bearer token", async () => {
    const calls = mockFetch(() => ({ candidates: [{ content: { parts: [{ text: ANSWER }] } }] }));
    await (await connect({ provider: "vertex", project: "p1", location: "us-central1", model: "gemini-2.5-flash", token: "ya29.t" }))("x");
    await (await connect({ provider: "vertex", project: "p1", location: "global", model: "gemini-2.5-flash", token: "ya29.t" }))("x");
    expect(calls[0]!.url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent");
    expect(calls[1]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-2.5-flash:generateContent");
    expect(calls[0]!.headers.authorization).toBe("Bearer ya29.t");
    expect(JSON.parse(calls[0]!.body).contents[0]).toEqual({ role: "user", parts: [{ text: "x" }] });
  });

  it("vertex: without a project anywhere it says which variable to set", async () => {
    mockFetch(() => ({}));
    await expect(connect({ provider: "vertex", location: "global", model: "m", token: "t" })).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it("azure: deployment URL with api-version, api-key header, no model in the body", async () => {
    const calls = mockFetch(() => ({ choices: [{ message: { content: ANSWER } }] }));
    const cfg: ByokConfig = { provider: "azure", endpoint: "https://acme.openai.azure.com", model: "gpt-4o-mini", apiVersion: "2024-10-21", key: "azk" };
    expect(await (await connect(cfg))("x")).toBe(ANSWER);
    expect(calls[0]!.url).toBe("https://acme.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21");
    expect(calls[0]!.headers["api-key"]).toBe("azk");
    expect(JSON.parse(calls[0]!.body)).toEqual({ messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } });
    await (await connect({ ...cfg, key: undefined, adToken: "entra" }))("x");
    expect(calls[1]!.headers.authorization).toBe("Bearer entra");
  });
});

describe("SigV4", () => {
  // Reference: botocore SigV4Auth on the same request, same credentials and time.
  it("matches botocore, including the double-encoded path of an ARN model id", () => {
    const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent("arn:aws:bedrock:us-east-1:123:inference-profile/us.amazon.nova-lite-v1:0")}/converse`;
    const h = signV4(
      { method: "POST", url, headers: { "content-type": "application/json" }, body: '{"a":1}' },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "tok" },
      "us-east-1",
      "bedrock",
      new Date("2026-11-27T05:45:03Z"),
    );
    expect(h["x-amz-date"]).toBe("20261127T054503Z");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261127/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=83b8ab0c1a7157d32b57a52f1eab7c459b71ae86f16ade2a075649559ac72814",
    );
  });
});

describe("AWS credential chain", () => {
  it("reads static keys from the shared credentials file for AWS_PROFILE", async () => {
    writeFileSync(join(dir, "aws-credentials"), "[default]\naws_access_key_id = D\naws_secret_access_key = DS\n\n[work]\naws_access_key_id = W\naws_secret_access_key = WS\naws_session_token = WT\n");
    expect(await awsCredentials("us-east-1")).toEqual({ accessKeyId: "D", secretAccessKey: "DS", sessionToken: undefined });
    env({ AWS_PROFILE: "work" });
    expect(await awsCredentials("us-east-1")).toEqual({ accessKeyId: "W", secretAccessKey: "WS", sessionToken: "WT" });
  });

  it("runs credential_process", async () => {
    const script = join(dir, "creds.js");
    writeFileSync(script, `process.stdout.write(JSON.stringify({ Version: 1, AccessKeyId: "P", SecretAccessKey: "PS", SessionToken: "PT" }))`);
    writeFileSync(join(dir, "aws-config"), `[default]\ncredential_process = "${process.execPath}" "${script}"\n`);
    expect(await awsCredentials("us-east-1")).toEqual({ accessKeyId: "P", secretAccessKey: "PS", sessionToken: "PT" });
  });

  it("uses the cached IAM Identity Center login", async () => {
    writeFileSync(
      join(dir, "aws-config"),
      "[profile dev]\nsso_session = corp\nsso_account_id = 111122223333\nsso_role_name = Dev\n\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = us-east-1\n",
    );
    const cache = join(dir, ".aws", "sso", "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `${createHash("sha1").update("corp").digest("hex")}.json`), JSON.stringify({ accessToken: "sso-tok", expiresAt: "2999-01-01T00:00:00Z" }));
    env({ AWS_PROFILE: "dev" });
    const calls = mockFetch(() => ({ roleCredentials: { accessKeyId: "S", secretAccessKey: "SS", sessionToken: "ST" } }));
    expect(await awsCredentials("us-east-1")).toEqual({ accessKeyId: "S", secretAccessKey: "SS", sessionToken: "ST" });
    expect(calls[0]!.url).toBe("https://portal.sso.us-east-1.amazonaws.com/federation/credentials?account_id=111122223333&role_name=Dev");
    expect(calls[0]!.headers["x-amz-sso_bearer_token"]).toBe("sso-tok");
  });

  it("says how to export credentials for role profiles", async () => {
    writeFileSync(join(dir, "aws-config"), "[default]\nrole_arn = arn:aws:iam::1:role/x\nsource_profile = base\n");
    await expect(awsCredentials("us-east-1")).rejects.toThrow(/export-credentials/);
  });

  it("uses container credentials (ECS, EKS Pod Identity)", async () => {
    env({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN: "pod" });
    const calls = mockFetch(() => ({ AccessKeyId: "C", SecretAccessKey: "CS", Token: "CT" }));
    expect(await awsCredentials("us-east-1")).toEqual({ accessKeyId: "C", secretAccessKey: "CS", sessionToken: "CT" });
    expect(calls[0]!.headers.authorization).toBe("pod");
  });

  it("uses web identity (EKS IRSA, CI OIDC)", async () => {
    writeFileSync(join(dir, "wi-token"), "jwt-abc\n");
    env({ AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "wi-token"), AWS_ROLE_ARN: "arn:aws:iam::1:role/ci" });
    const calls = mockFetch(() => ({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "I", SecretAccessKey: "IS", SessionToken: "IT" } } } }));
    expect(await awsCredentials("eu-west-1")).toEqual({ accessKeyId: "I", secretAccessKey: "IS", sessionToken: "IT" });
    const u = new URL(calls[0]!.url);
    expect(u.host).toBe("sts.eu-west-1.amazonaws.com");
    expect(u.searchParams.get("WebIdentityToken")).toBe("jwt-abc");
  });

  it("uses EC2 instance metadata (IMDSv2) when nothing else is set", async () => {
    env({ AWS_EC2_METADATA_DISABLED: "", AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://imds.test" });
    const calls = mockFetch((c) =>
      c.url.endsWith("/api/token") ? "imds-tok" : c.url.endsWith("/security-credentials/") ? "app-role" : { AccessKeyId: "E", SecretAccessKey: "ES", Token: "ET" },
    );
    expect(await awsCredentials("us-east-1")).toEqual({ accessKeyId: "E", secretAccessKey: "ES", sessionToken: "ET" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[2]!.url).toBe("http://imds.test/latest/meta-data/iam/security-credentials/app-role");
    expect(calls[2]!.headers["x-aws-ec2-metadata-token"]).toBe("imds-tok");
  });

  it("explains what to set when there are no credentials", async () => {
    await expect(awsCredentials("us-east-1")).rejects.toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
  });
});

describe("Google Application Default Credentials", () => {
  it("refreshes gcloud user credentials and takes the quota project", async () => {
    mkdirSync(join(dir, "gcloud"), { recursive: true });
    writeFileSync(
      join(dir, "gcloud", "application_default_credentials.json"),
      JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "cs", refresh_token: "rt", quota_project_id: "qp" }),
    );
    const calls = mockFetch(() => ({ access_token: "ya29.user" }));
    expect(await googleAuth()).toEqual({ token: "ya29.user", project: "qp" });
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ grant_type: "refresh_token", client_id: "cid", client_secret: "cs", refresh_token: "rt" });
  });

  it("signs a JWT for a service account key file", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = join(dir, "sa.json");
    writeFileSync(
      file,
      JSON.stringify({ type: "service_account", client_email: "sa@p2.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token", project_id: "p2" }),
    );
    env({ GOOGLE_APPLICATION_CREDENTIALS: file });
    const calls = mockFetch(() => ({ access_token: "ya29.sa" }));
    expect(await googleAuth()).toEqual({ token: "ya29.sa", project: "p2" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, p, s] = form.get("assertion")!.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: "sa@p2.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/cloud-platform" });
  });

  it("falls back to the metadata server on Google Cloud", async () => {
    env({ GCE_METADATA_HOST: "md.test" });
    const calls = mockFetch((c) => (c.url.endsWith("/token") ? { access_token: "ya29.md" } : "p3"));
    expect(await googleAuth()).toEqual({ token: "ya29.md", project: "p3" });
    expect(calls[0]!.headers["metadata-flavor"]).toBe("Google");
  });

  it("vertex end to end: project from ADC when GOOGLE_CLOUD_PROJECT is unset", async () => {
    env({ GCE_METADATA_HOST: "md.test" });
    const calls = mockFetch((c) =>
      c.url.endsWith("/token") ? { access_token: "ya29.md" } : c.url.endsWith("/project-id") ? "p3" : { candidates: [{ content: { parts: [{ text: ANSWER }] } }] },
    );
    await (await connect({ provider: "vertex", location: "global", model: "gemini-2.5-flash" }))("x");
    expect(calls[2]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/p3/locations/global/publishers/google/models/gemini-2.5-flash:generateContent");
  });
});

describe("refineWithByok", () => {
  const schema: SchemaModel = { dialect: "postgres", source: "t.sql", tables: parseDDL("create table t (id serial primary key, a text, b text);") };

  it("relabels only uncertain columns, through a cloud provider, and checks the answer", async () => {
    const plan = infer(schema);
    for (const c of plan.columns) if (c.column !== "id") c.confidence = 0.1;
    env({ AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" });
    const calls = mockFetch(() => ({ output: { message: { content: [{ text: '{"t.a":"email","t.b":"not-a-label"}' }] } } }));
    const r = await refineWithByok(plan, schema, { provider: "bedrock", region: "us-east-1", model: "m" });
    expect(r).toMatchObject({ provider: "bedrock", model: "m", changed: 1 });
    expect(plan.columns.find((c) => c.column === "a")).toMatchObject({ meaning: "email", evidence: "your AI provider (bedrock)" });
    const prompt = JSON.parse(calls[0]!.body).messages[0].content[0].text as string;
    expect(prompt).toContain("t.a: text");
    expect(prompt).not.toContain("t.id");
  });

  it("makes no request and needs no credentials when nothing is uncertain", async () => {
    const plan = infer(schema);
    for (const c of plan.columns) c.confidence = 0.99;
    const calls = mockFetch(() => ({}));
    const r = await refineWithByok(plan, schema, { provider: "vertex", location: "global", model: "m" });
    expect(r.asked).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
