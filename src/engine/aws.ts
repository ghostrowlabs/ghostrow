import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * AWS Signature Version 4 and the parts of the standard credential chain the CLI needs, with
 * node:crypto and fetch only. The AWS SDK would add megabytes to the single-file bundle for one
 * signed POST.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();
/** RFC 3986 encoding (encodeURIComponent leaves !'()* alone). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Returns the headers to send: the given ones plus host, x-amz-date, the session token and Authorization. */
export function signV4(
  req: { method: string; url: string; headers?: Record<string, string>; body?: string },
  creds: AwsCredentials,
  region: string,
  service: string,
  now: Date = new Date(),
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  // Every service but S3 encodes the (already encoded) path segments a second time.
  const canonicalUri = url.pathname.split("/").map((seg) => enc(seg)).join("/") || "/";
  const canonicalQuery = [...url.searchParams]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [req.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, sha256(req.body ?? "")].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

type Ini = Record<string, Record<string, string>>;

function readIni(path: string): Ini {
  const out: Ini = {};
  if (!existsSync(path)) return out;
  let section: Record<string, string> | null = null;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (head) {
      section = out[head[1]!] ??= {};
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && section) section[kv[1]!.toLowerCase()] = kv[2]!;
  }
  return out;
}

function credentialsFile(): string {
  return process.env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials");
}
function configFile(): string {
  return process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
}
export function awsProfile(): string {
  return process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || "default";
}
function configSection(profile: string): Record<string, string> {
  const ini = readIni(configFile());
  return (profile === "default" ? ini.default : undefined) ?? ini[`profile ${profile}`] ?? {};
}

/** AWS_REGION, AWS_DEFAULT_REGION, then the profile's region in ~/.aws/config. */
export function awsRegion(): string | undefined {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || configSection(awsProfile()).region || undefined;
}

const TIMEOUT = 5_000;

/**
 * Environment variables, then the shared credentials/config files (static keys, credential_process,
 * IAM Identity Center via the CLI's cached login), web identity, ECS/EKS container credentials and
 * finally EC2 instance metadata (IMDSv2) — the order the AWS SDKs use.
 */
export async function awsCredentials(region: string): Promise<AwsCredentials> {
  const env = process.env;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
  }
  const profile = awsProfile();
  const fromFiles = await fromProfile(profile);
  if (fromFiles) return fromFiles;
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return webIdentity(env.AWS_WEB_IDENTITY_TOKEN_FILE, env.AWS_ROLE_ARN, region);
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return container();
  if (env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true") {
    const imds = await instanceMetadata().catch(() => null);
    if (imds) return imds;
  }
  throw new Error(
    `no AWS credentials found (profile "${profile}"). Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, set AWS_PROFILE, ` +
      "run `aws sso login`, or use a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK.",
  );
}

async function fromProfile(profile: string): Promise<AwsCredentials | null> {
  const cred = readIni(credentialsFile())[profile] ?? {};
  const conf = configSection(profile);
  const keys = cred.aws_access_key_id ? cred : conf.aws_access_key_id ? conf : null;
  if (keys?.aws_access_key_id && keys.aws_secret_access_key) {
    return { accessKeyId: keys.aws_access_key_id, secretAccessKey: keys.aws_secret_access_key, sessionToken: keys.aws_session_token || undefined };
  }
  const proc = cred.credential_process ?? conf.credential_process;
  if (proc) return credentialProcess(proc);
  if (conf.sso_session || conf.sso_start_url) return sso(conf);
  if (conf.role_arn || cred.role_arn) {
    throw new Error(
      `AWS profile "${profile}" assumes a role, which Ghostrow doesn't do itself. Export credentials first: ` +
        "`aws configure export-credentials --format env` (or set credential_process in the profile).",
    );
  }
  return null;
}

function credentialProcess(command: string): AwsCredentials {
  const r = spawnSync(command, { shell: true, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`credential_process failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  const j = JSON.parse(r.stdout) as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
  if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error("credential_process returned no AccessKeyId/SecretAccessKey.");
  return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.SessionToken };
}

async function sso(conf: Record<string, string>): Promise<AwsCredentials> {
  let startUrl = conf.sso_start_url;
  let ssoRegion = conf.sso_region;
  let cacheKey = startUrl;
  if (conf.sso_session) {
    const session = readIni(configFile())[`sso-session ${conf.sso_session}`] ?? {};
    startUrl = session.sso_start_url ?? startUrl;
    ssoRegion = session.sso_region ?? ssoRegion;
    cacheKey = conf.sso_session;
  }
  if (!cacheKey || !ssoRegion || !conf.sso_account_id || !conf.sso_role_name) throw new Error("the AWS SSO profile is incomplete (sso_region, sso_account_id, sso_role_name).");
  const file = join(homedir(), ".aws", "sso", "cache", `${createHash("sha1").update(cacheKey).digest("hex")}.json`);
  const cached = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { accessToken?: string; expiresAt?: string }) : {};
  if (!cached.accessToken || (cached.expiresAt && Date.parse(cached.expiresAt) < Date.now())) throw new Error("the AWS SSO login has expired. Run `aws sso login`.");
  const u = `https://portal.sso.${ssoRegion}.amazonaws.com/federation/credentials?account_id=${enc(conf.sso_account_id)}&role_name=${enc(conf.sso_role_name)}`;
  const r = await fetch(u, { headers: { "x-amz-sso_bearer_token": cached.accessToken }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`AWS SSO answered ${r.status}. Run \`aws sso login\`.`);
  const j = (await r.json()) as { roleCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string } };
  if (!j.roleCredentials) throw new Error("AWS SSO returned no role credentials.");
  return j.roleCredentials;
}

async function webIdentity(tokenFile: string, roleArn: string, region: string): Promise<AwsCredentials> {
  const q = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: process.env.AWS_ROLE_SESSION_NAME ||`ghostrow-${Date.now()}`,
    WebIdentityToken: readFileSync(tokenFile, "utf8").trim(),
  });
  const r = await fetch(`https://sts.${region}.amazonaws.com/?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`AWS STS answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as {
    AssumeRoleWithWebIdentityResponse?: { AssumeRoleWithWebIdentityResult?: { Credentials?: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } } };
  };
  const c = j.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
  if (!c) throw new Error("AWS STS returned no credentials.");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

async function container(): Promise<AwsCredentials> {
  const env = process.env;
  const url = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}` : env.AWS_CONTAINER_CREDENTIALS_FULL_URI!;
  const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? readFileSync(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, "utf8").trim() : env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  const r = await fetch(url, { headers: token ? { authorization: token } : {}, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`the container credentials endpoint answered ${r.status}.`);
  return metadataCreds(await r.json());
}

async function instanceMetadata(): Promise<AwsCredentials> {
  const base = process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.replace(/\/$/, "") || "http://169.254.169.254";
  const signal = () => AbortSignal.timeout(1_000);
  const t = await fetch(`${base}/latest/api/token`, { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" }, signal: signal() });
  if (!t.ok) throw new Error("no instance metadata");
  const headers = { "x-aws-ec2-metadata-token": await t.text() };
  const role = (await (await fetch(`${base}/latest/meta-data/iam/security-credentials/`, { headers, signal: signal() })).text()).split("\n")[0]!.trim();
  if (!role) throw new Error("no instance role");
  const r = await fetch(`${base}/latest/meta-data/iam/security-credentials/${role}`, { headers, signal: signal() });
  if (!r.ok) throw new Error("no instance role credentials");
  return metadataCreds(await r.json());
}

function metadataCreds(j: unknown): AwsCredentials {
  const c = j as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string };
  if (!c.AccessKeyId || !c.SecretAccessKey) throw new Error("the metadata endpoint returned no credentials.");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token };
}
