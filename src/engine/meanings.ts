import type { ColumnModel, TableModel } from "../connect/types.js";

/**
 * The meanings gr-schema-1 can assign to a column. Each one has a value model in
 * gen/values.ts. Inference is a fixed, weighted vote over four signals: the column
 * name (split into words), the declared type, the table it sits in, and (for a live
 * database) a capped sample of existing values. No signal is learned from user data.
 */
export const MEANINGS = [
  "id",
  "reference",
  "uuid",
  "email",
  "phone",
  "first_name",
  "last_name",
  "full_name",
  "username",
  "password_hash",
  "token",
  "company",
  "job_title",
  "title",
  "description",
  "slug",
  "url",
  "domain",
  "ip_address",
  "sku",
  "national_id_lk",
  "national_id",
  "postal_code",
  "street",
  "address",
  "city",
  "region",
  "country",
  "country_code",
  "currency_code",
  "language_code",
  "timezone",
  "latitude",
  "longitude",
  "money",
  "percent",
  "quantity",
  "count",
  "age",
  "rating",
  "year",
  "birth_date",
  "date",
  "datetime",
  "time",
  "boolean",
  "status",
  "color",
  "mime_type",
  "file_path",
  "json",
  "bytes",
  "integer",
  "number",
  "code",
  "text",
] as const;

export type MeaningId = (typeof MEANINGS)[number];

export const MEANING_LABEL: Record<MeaningId, string> = {
  id: "row id",
  reference: "reference",
  uuid: "UUID",
  email: "email",
  phone: "phone number",
  first_name: "first name",
  last_name: "last name",
  full_name: "person's name",
  username: "username",
  password_hash: "password hash",
  token: "token",
  company: "company name",
  job_title: "job title",
  title: "title",
  description: "description",
  slug: "URL slug",
  url: "URL",
  domain: "domain name",
  ip_address: "IP address",
  sku: "SKU",
  national_id_lk: "Sri Lankan NIC",
  national_id: "national ID",
  postal_code: "postal code",
  street: "street address",
  address: "address",
  city: "city",
  region: "region",
  country: "country",
  country_code: "country code",
  currency_code: "currency code",
  language_code: "language code",
  timezone: "time zone",
  latitude: "latitude",
  longitude: "longitude",
  money: "amount",
  percent: "percentage",
  quantity: "quantity",
  count: "count",
  age: "age",
  rating: "rating",
  year: "year",
  birth_date: "date of birth",
  date: "date",
  datetime: "date and time",
  time: "time of day",
  boolean: "yes/no",
  status: "status",
  color: "colour",
  mime_type: "MIME type",
  file_path: "file path",
  json: "JSON",
  bytes: "binary data",
  integer: "integer",
  number: "number",
  code: "code",
  text: "text",
};

/** Split a column name into lower-case words: `createdAt` → [created, at], `ORDER_TOTAL` → [order, total]. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type Vote = Partial<Record<MeaningId, number>>;

/** Word patterns: every listed word or phrase that appears in the column name votes. */
const NAME_RULES: [MeaningId, number, (w: string[], joined: string) => boolean][] = [
  ["email", 5, (w) => w.includes("email") || w.includes("mail") || w.includes("e_mail")],
  ["phone", 5, (w) => w.some((x) => ["phone", "mobile", "tel", "telephone", "cell", "fax", "msisdn"].includes(x))],
  ["first_name", 6, (_, j) => /(^|_)(first_?name|given_?name|fname|forename)$/.test(j)],
  ["last_name", 6, (_, j) => /(^|_)(last_?name|family_?name|surname|lname)$/.test(j)],
  ["full_name", 4, (_, j) => /(^|_)(full_?name|display_?name|contact_?name|customer_?name|person_?name|owner_?name|author_?name|recipient_?name|billing_?name)$/.test(j)],
  ["username", 6, (_, j) => /(^|_)(user_?name|login|handle|screen_?name|nickname|nick)$/.test(j)],
  ["password_hash", 7, (w) => w.some((x) => ["password", "passwd", "pwd"].includes(x))],
  ["token", 4, (w) => w.some((x) => ["token", "secret", "api_key", "apikey", "hash", "nonce", "salt", "signature"].includes(x))],
  ["company", 5, (_, j) => /(^|_)(company|organisation|organization|org|employer|business|vendor|supplier)(_?name)?$/.test(j)],
  ["job_title", 6, (_, j) => /(^|_)(job_?title|position|occupation|designation|role_?title)$/.test(j)],
  ["title", 4, (w) => w.includes("title") || w.includes("headline") || w.includes("subject") || w.includes("label")],
  ["description", 5, (w) => w.some((x) => ["description", "desc", "summary", "bio", "about", "notes", "note", "comment", "comments", "body", "content", "message", "details", "remarks"].includes(x))],
  ["slug", 6, (w) => w.includes("slug") || w.includes("permalink")],
  ["url", 5, (w) => w.some((x) => ["url", "uri", "link", "website", "homepage", "href", "avatar", "image", "photo", "logo", "thumbnail"].includes(x))],
  ["domain", 5, (w) => w.includes("domain") || w.includes("hostname") || w.includes("host")],
  ["ip_address", 6, (_, j) => /(^|_)(ip|ip_?address|ipv4|ipv6|remote_?addr|client_?ip)$/.test(j)],
  ["sku", 6, (_, j) => /(^|_)(sku|part_?(no|number|code)|item_?code|product_?code|barcode|ean|upc|isbn|gtin|model_?number)$/.test(j)],
  ["national_id_lk", 8, (w) => w.includes("nic")],
  ["national_id", 6, (_, j) => /(^|_)(national_?id|ssn|tin|tax_?id|passport(_?(no|number))?|id_?number|nin|aadhaar|pan)$/.test(j)],
  ["postal_code", 6, (_, j) => /(^|_)(postal_?code|post_?code|zip(_?code)?|postcode|pin_?code)$/.test(j)],
  ["street", 5, (_, j) => /(^|_)(street|address_?(line)?_?[12]?|addr(ess)?_?[12]?|line_?[12])$/.test(j)],
  ["address", 4, (w) => w.includes("address") || w.includes("location")],
  ["city", 6, (w) => w.some((x) => ["city", "town", "suburb", "locality", "municipality"].includes(x))],
  ["region", 5, (_, j) => /(^|_)(state|province|region|county|district|prefecture)(_?name)?$/.test(j)],
  ["country", 5, (w) => w.includes("country") || w.includes("nationality") || w.includes("citizenship")],
  ["country_code", 7, (_, j) => /(^|_)(country_?code|country_?iso|iso_?country|cc)$/.test(j)],
  ["currency_code", 7, (_, j) => /(^|_)(currency|currency_?code|ccy|iso_?currency)$/.test(j)],
  ["language_code", 6, (_, j) => /(^|_)(lang|language|locale)(_?code)?$/.test(j)],
  ["timezone", 7, (_, j) => /(^|_)(time_?zone|tz)$/.test(j)],
  ["latitude", 7, (w) => w.includes("lat") || w.includes("latitude")],
  ["longitude", 7, (w) => w.some((x) => ["lng", "lon", "long", "longitude"].includes(x))],
  ["money", 5, (w) => w.some((x) => ["total", "subtotal", "amount", "price", "cost", "fee", "fees", "charge", "balance", "revenue", "salary", "wage", "payment", "paid", "refund", "tax", "vat", "discount", "budget", "income", "spend", "earnings", "msrp", "mrp", "tip", "deposit", "credit", "debit", "value"].includes(x))],
  ["percent", 6, (w) => w.some((x) => ["percent", "percentage", "pct", "ratio", "rate"].includes(x)) && !w.includes("exchange")],
  ["quantity", 6, (w) => w.some((x) => ["quantity", "qty", "units", "stock", "inventory", "seats"].includes(x))],
  ["count", 5, (w) => w.some((x) => ["count", "views", "visits", "clicks", "likes", "attempts", "retries", "times", "hits", "downloads", "followers", "num", "number_of"].includes(x)) || w[0] === "num"],
  ["age", 7, (w) => w.length === 1 && w[0] === "age"],
  ["rating", 6, (w) => w.some((x) => ["rating", "stars", "score", "grade"].includes(x))],
  ["year", 6, (w) => w[w.length - 1] === "year" || w.includes("yr")],
  ["birth_date", 8, (_, j) => /(^|_)(birth_?(day|date)|date_?of_?birth|dob|born_?(on|at))$/.test(j)],
  ["datetime", 4, (w) => ["at", "on", "time", "timestamp", "datetime", "ts"].includes(w[w.length - 1] ?? "") || w.some((x) => ["created", "updated", "deleted", "modified", "expires", "expired", "published", "posted", "sent", "received", "logged", "started", "ended", "starts", "ends", "opened", "closed", "paid", "shipped", "delivered", "cancelled", "canceled", "joined", "registered", "confirmed", "verified", "scheduled", "completed", "approved"].includes(x))],
  ["date", 4, (w) => w[w.length - 1] === "date" || w.includes("day") || w.includes("deadline")],
  ["boolean", 6, (w) => ["is", "has", "can", "should", "was", "allow", "enable", "show"].includes(w[0] ?? "") || ["active", "enabled", "disabled", "verified", "deleted", "archived", "published", "visible", "flag", "confirmed", "locked", "default", "primary", "featured", "paid", "approved"].includes(w.join("_"))],
  ["status", 5, (w) => ["status", "state", "kind", "type", "category", "level", "tier", "phase", "stage", "priority", "gender", "sex", "plan", "role", "channel", "source", "method", "mode", "severity", "visibility"].includes(w[w.length - 1] ?? "")],
  ["color", 7, (w) => w.includes("color") || w.includes("colour") || w.includes("hex")],
  ["mime_type", 7, (_, j) => /(^|_)(mime_?type|content_?type|media_?type)$/.test(j)],
  ["file_path", 6, (w) => w.some((x) => ["path", "filename", "file", "filepath", "key"].includes(x)) && !w.includes("api")],
  ["code", 3, (w) => w[w.length - 1] === "code" || w.includes("ref") || w.includes("reference") || w.includes("number") || w.includes("no")],
  ["year", 2, (w) => w.includes("year")],
];

/** The words that mean "this is a person/company name" depend on the table. */
function nameColumnVote(col: string, table: string): Vote {
  if (words(col).join("_") !== "name") return {};
  const t = words(table).join("_");
  if (/(user|customer|client|person|people|member|employee|staff|contact|author|student|patient|account|owner|driver|teacher|guest|subscriber|applicant|candidate|player)/.test(t)) return { full_name: 6 };
  if (/(compan|organi[sz]ation|org|vendor|supplier|merchant|tenant|team|brand|business|partner)/.test(t)) return { company: 6 };
  if (/(countr)/.test(t)) return { country: 6 };
  if (/(cit(y|ies)|town)/.test(t)) return { city: 6 };
  return { title: 4 };
}

export function nameVotes(col: ColumnModel, table: TableModel): Vote {
  const w = words(col.name);
  const joined = w.join("_");
  const v: Vote = { ...nameColumnVote(col.name, table.name) };
  for (const [meaning, weight, test] of NAME_RULES) if (test(w, joined)) v[meaning] = Math.max(v[meaning] ?? 0, weight);
  // `id` on its own, or `<table>_id` as a primary key.
  if (joined === "id" || (col.primaryKey && (joined === `${words(table.name).join("_")}_id` || joined.endsWith("_id")))) v.id = (v.id ?? 0) + 6;
  return v;
}

/** What the declared type allows, and nudges. A type can veto meanings that can't fit. */
export function typeVotes(c: ColumnModel): Vote {
  const v: Vote = {};
  switch (c.type) {
    case "uuid":
      v.uuid = 6;
      break;
    case "boolean":
      v.boolean = 10;
      break;
    case "decimal":
      if (c.scale === 2) v.money = 3;
      else v.number = 2;
      break;
    case "integer":
      v.integer = 2;
      if (c.intBytes === 1 || c.intBytes === 2) v.count = 1;
      break;
    case "real":
      v.number = 2;
      break;
    case "date":
      v.date = 4;
      break;
    case "datetime":
      v.datetime = 4;
      break;
    case "time":
      v.time = 10;
      break;
    case "enum":
      v.status = 8;
      break;
    case "json":
      v.json = 10;
      break;
    case "bytes":
      v.bytes = 10;
      break;
    default:
      v.text = 1;
      if (c.maxLength !== undefined && c.maxLength <= 3) v.code = 2;
  }
  if (c.primaryKey && c.type !== "uuid" && (c.type === "integer" || c.autoIncrement)) v.id = (v.id ?? 0) + 8;
  if (c.primaryKey && c.type === "uuid") v.uuid = (v.uuid ?? 0) + 4;
  if (c.primaryKey && c.type === "text" && /^(gen_random_uuid|uuid_generate|uuid\(|newid|cuid|nanoid)/i.test(c.defaultValue ?? "")) v.uuid = (v.uuid ?? 0) + 6;
  return v;
}

/** Meanings a column's type can actually hold. Anything else is ruled out whatever the name says. */
export function compatible(m: MeaningId, c: ColumnModel): boolean {
  const textish = c.type === "text" || c.type === "enum";
  switch (m) {
    case "id":
      return c.type === "integer" || c.type === "text" || c.type === "decimal";
    case "reference":
      return true;
    case "uuid":
      return c.type === "uuid" || (textish && (c.maxLength === undefined || c.maxLength >= 32));
    case "boolean":
      return c.type === "boolean" || (c.type === "integer" && (c.intBytes ?? 8) <= 2) || (textish && (c.maxLength ?? 5) <= 5);
    case "money":
    case "percent":
    case "latitude":
    case "longitude":
    case "number":
      return c.type === "decimal" || c.type === "real" || (c.type === "integer" && m === "money") || (c.type === "integer" && m === "percent");
    case "quantity":
    case "count":
    case "age":
    case "rating":
    case "year":
    case "integer":
      return c.type === "integer" || c.type === "decimal" || c.type === "real" || (m === "year" && textish);
    case "date":
    case "birth_date":
      return c.type === "date" || c.type === "datetime" || textish;
    case "datetime":
      return c.type === "datetime" || c.type === "date" || textish || (c.type === "integer" && (c.intBytes ?? 8) >= 4);
    case "time":
      return c.type === "time" || textish;
    case "json":
      return c.type === "json" || textish;
    case "bytes":
      return c.type === "bytes";
    case "status":
      return textish || c.type === "integer";
    default:
      return textish;
  }
}

/** Votes from existing values (live database only). */
export function sampleVotes(values: unknown[]): Vote {
  const v: Vote = {};
  const s = values.filter((x) => x !== null && x !== undefined).map(String);
  if (s.length < 3) return v;
  const share = (re: RegExp) => s.filter((x) => re.test(x)).length / s.length;
  if (share(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) >= 0.8) v.email = 6;
  if (share(/^(\d{9}[VvXx]|\d{12})$/) >= 0.8) v.national_id_lk = 8;
  if (share(/^\+?[\d\s().-]{7,}$/) >= 0.8 && share(/[a-z]/i) === 0) v.phone = 3;
  if (share(/^https?:\/\//) >= 0.8) v.url = 6;
  if (share(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) >= 0.8) v.uuid = 6;
  if (share(/^#[0-9a-f]{6}$/i) >= 0.8) v.color = 6;
  if (share(/^\d{1,3}(\.\d{1,3}){3}$/) >= 0.8) v.ip_address = 6;
  if (share(/^[A-Z]{3}$/) >= 0.9 && new Set(s).size <= 40) v.currency_code = 3;
  if (share(/^[a-z0-9]+(-[a-z0-9]+)+$/) >= 0.8) v.slug = 4;
  const distinct = new Set(s).size;
  if (distinct <= Math.max(3, s.length * 0.2) && distinct <= 30 && share(/^[\w -]{1,30}$/) === 1) v.status = 4;
  return v;
}

export function bestMeaning(votes: Vote, c: ColumnModel): { meaning: MeaningId; score: number; total: number } {
  let best: MeaningId = fallbackFor(c);
  let score = 0;
  let total = 0;
  for (const m of MEANINGS) {
    const s = votes[m];
    if (s === undefined || !compatible(m, c)) continue;
    total += s;
    if (s > score) {
      best = m;
      score = s;
    }
  }
  return { meaning: best, score, total };
}

/** What a column with no useful signal holds, from its type alone. */
export function fallbackFor(c: ColumnModel): MeaningId {
  switch (c.type) {
    case "integer":
      return "integer";
    case "decimal":
    case "real":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "time":
      return "time";
    case "uuid":
      return "uuid";
    case "json":
      return "json";
    case "bytes":
      return "bytes";
    case "enum":
      return "status";
    default:
      return c.maxLength !== undefined && c.maxLength <= 12 ? "code" : "text";
  }
}
