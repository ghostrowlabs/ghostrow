/**
 * Synthetic schemas with known meanings: the ground-truth half of the training data.
 * Tables are assembled from templates (column meaning + many ways people name and type it),
 * then renamed with the conventions real schemas use (camelCase, prefixes, abbreviations,
 * upper case, dialect type names). The vocabulary was written from general knowledge of how
 * schemas are named, independently of the held-out schemas.
 *
 *   npx tsx training/tools/synth.ts [tables=6000] [seed=1]   (from cli/) → training/data/synth.jsonl
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ColumnModel, ColumnType, TableModel } from "../../src/connect/types.js";
import { normalizeTable } from "../../src/connect/types.js";
import { infer } from "../../src/engine/infer.js";
import type { MeaningId } from "../../src/engine/meanings.js";
import { columnText } from "../../src/model/features.js";

const TABLES = Number(process.argv[2] ?? 6000);
let state = Number(process.argv[3] ?? 1) >>> 0;
function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------------------------------------------------------------- types
type T = { type: ColumnType; raw: string; maxLength?: number; precision?: number; scale?: number; intBytes?: number };
type Dialect = "postgres" | "mysql" | "sqlserver" | "sqlite" | "prisma" | "django";
let dialect: Dialect = "postgres";

function text(n?: number): T {
  const len = n ?? pick([20, 32, 50, 64, 100, 120, 150, 200, 255, 255, 255, 500]);
  const raw = {
    postgres: pick([`varchar(${len})`, `character varying(${len})`, "text"]),
    mysql: pick([`varchar(${len})`, `VARCHAR(${len})`]),
    sqlserver: pick([`nvarchar(${len})`, `varchar(${len})`, `NVARCHAR(${len})`]),
    sqlite: pick(["TEXT", `VARCHAR(${len})`, "text"]),
    prisma: pick(["String", `VarChar(${len})`]),
    django: `varchar(${len})`,
  }[dialect];
  const unbounded = /^(text|TEXT|String)$/.test(raw);
  return { type: "text", raw, maxLength: unbounded ? undefined : len };
}
function char(n: number): T {
  const raw = { postgres: pick([`char(${n})`, `character(${n})`, `varchar(${n})`]), mysql: `char(${n})`, sqlserver: pick([`nchar(${n})`, `char(${n})`]), sqlite: pick(["TEXT", `CHAR(${n})`]), prisma: pick([`Char(${n})`, `VarChar(${n})`]), django: `varchar(${n})` }[dialect];
  return { type: "text", raw, maxLength: raw === "TEXT" ? undefined : n };
}
function longText(): T {
  return { type: "text", raw: { postgres: "text", mysql: pick(["text", "longtext", "mediumtext"]), sqlserver: pick(["nvarchar(max)", "varchar(max)", "ntext"]), sqlite: "TEXT", prisma: pick(["String", "Text"]), django: "text" }[dialect] };
}
function integer(bytes = pick([4, 4, 4, 8, 2])): T {
  const names: Record<number, Record<Dialect, string[]>> = {
    1: { postgres: ["smallint"], mysql: ["tinyint", "tinyint(1)", "tinyint unsigned"], sqlserver: ["tinyint"], sqlite: ["INTEGER"], prisma: ["Int"], django: ["smallint"] },
    2: { postgres: ["smallint", "int2"], mysql: ["smallint", "smallint unsigned"], sqlserver: ["smallint"], sqlite: ["INTEGER"], prisma: ["Int", "SmallInt"], django: ["smallint"] },
    4: { postgres: ["integer", "int", "int4"], mysql: ["int", "int(11)", "int unsigned"], sqlserver: ["int"], sqlite: ["INTEGER", "INT"], prisma: ["Int"], django: ["integer"] },
    8: { postgres: ["bigint", "int8"], mysql: ["bigint", "bigint unsigned", "bigint(20)"], sqlserver: ["bigint"], sqlite: ["INTEGER"], prisma: ["BigInt", "Int"], django: ["bigint"] },
  };
  return { type: "integer", raw: pick(names[bytes]![dialect]), intBytes: bytes };
}
function decimal(p = pick([10, 12, 18, 19, 8]), s = pick([2, 2, 2, 4])): T {
  const raw = { postgres: pick([`numeric(${p},${s})`, `decimal(${p},${s})`]), mysql: `decimal(${p},${s})`, sqlserver: pick([`decimal(${p},${s})`, `numeric(${p},${s})`, "money"]), sqlite: pick(["NUMERIC", `DECIMAL(${p},${s})`, "REAL"]), prisma: `Decimal(${p}, ${s})`, django: `numeric(${p},${s})` }[dialect];
  if (raw === "REAL") return { type: "real", raw };
  return { type: "decimal", raw, precision: p, scale: raw === "money" ? 4 : s };
}
function real(): T {
  return { type: "real", raw: { postgres: pick(["double precision", "real", "float8"]), mysql: pick(["double", "float"]), sqlserver: pick(["float", "real"]), sqlite: "REAL", prisma: "Float", django: "double precision" }[dialect] };
}
function bool(): T {
  if (dialect === "mysql" && chance(0.5)) return integer(1);
  if (dialect === "sqlserver") return { type: "boolean", raw: "bit" };
  return { type: "boolean", raw: { postgres: pick(["boolean", "bool"]), mysql: "boolean", sqlserver: "bit", sqlite: pick(["BOOLEAN", "INTEGER"]), prisma: "Boolean", django: "boolean" }[dialect] };
}
/** A yes/no flag stored without a boolean type. */
function flagLike(): T {
  return pick([integer(1), integer(2), char(1), integer(4)]);
}
function date(): T {
  return { type: "date", raw: pick(["date", "DATE"]) };
}
function datetime(): T {
  return { type: "datetime", raw: { postgres: pick(["timestamp", "timestamptz", "timestamp with time zone", "timestamp without time zone"]), mysql: pick(["datetime", "timestamp", "datetime(6)"]), sqlserver: pick(["datetime2", "datetime", "datetimeoffset"]), sqlite: pick(["DATETIME", "TEXT", "TIMESTAMP"]), prisma: pick(["DateTime", "Timestamptz(6)", "Timestamp(3)"]), django: pick(["timestamp", "timestamp with time zone"]) }[dialect] };
}
function time(): T {
  return { type: "time", raw: "time" };
}
function uuid(): T {
  if (dialect === "mysql" || dialect === "sqlite") return char(36);
  if (dialect === "sqlserver") return { type: "uuid", raw: "uniqueidentifier" };
  return { type: "uuid", raw: pick(["uuid", "Uuid"]) };
}
function json(): T {
  return { type: "json", raw: { postgres: pick(["jsonb", "json"]), mysql: "json", sqlserver: "nvarchar(max)", sqlite: "TEXT", prisma: "Json", django: "jsonb" }[dialect] };
}
function bytes(): T {
  return { type: "bytes", raw: { postgres: "bytea", mysql: pick(["blob", "longblob", "varbinary(255)"]), sqlserver: pick(["varbinary(max)", "image"]), sqlite: "BLOB", prisma: "Bytes", django: "bytea" }[dialect] };
}
function enumOf(values: string[]): T & { enumValues: string[] } {
  return { type: "enum", raw: dialect === "mysql" ? `enum(${values.map((v) => `'${v}'`).join(",")})` : `${pick(["status", "kind", "type"])}_enum`, enumValues: values };
}

// ---------------------------------------------------------------- columns
interface Slot {
  m: MeaningId;
  names: string[];
  type: () => T;
  /** Probability the slot appears when its table template is used. */
  p?: number;
}
const S = (m: MeaningId, names: string[], type: () => T, p = 1): Slot => ({ m, names, type, p });

const PERSON_NAME = [
  S("first_name", ["first_name", "firstname", "given_name", "fname", "forename", "first_nm"], () => text(pick([40, 50, 100]))),
  S("last_name", ["last_name", "lastname", "surname", "family_name", "lname", "last_nm"], () => text(pick([40, 50, 100]))),
];
const CONTACT = [
  S("email", ["email", "email_address", "mail", "e_mail", "contact_email", "primary_email", "email_addr"], () => text(pick([120, 254, 255, 320]))),
  S("phone", ["phone", "phone_number", "mobile", "mobile_no", "tel", "telephone", "contact_no", "cell_phone", "phone_no", "msisdn", "fax"], () => text(pick([15, 20, 24, 32])), 0.8),
];
const ADDRESS = [
  S("street", ["address_line1", "address1", "street", "street_address", "addr_line_1", "line1", "address"], () => text(pick([70, 100, 120, 255]))),
  S("street", ["address_line2", "address2", "addr_line_2", "line2", "street2"], () => text(pick([70, 100, 255])), 0.5),
  S("city", ["city", "town", "city_name", "locality"], () => text(pick([40, 60, 100]))),
  S("region", ["state", "province", "region", "state_province", "county", "district"], () => text(pick([40, 60, 100])), 0.8),
  S("postal_code", ["postal_code", "zip", "zip_code", "postcode", "post_code", "zipcode", "pin_code"], () => text(pick([10, 12, 16, 20]))),
  S("country_code", ["country", "country_code", "country_iso", "iso_country"], () => char(2), 0.5),
  S("country", ["country", "country_name", "nation"], () => text(pick([40, 60, 100])), 0.5),
];
const AUDIT = [
  S("datetime", ["created_at", "createdAt", "created", "date_created", "created_on", "creation_time", "inserted_at", "create_time"], datetime),
  S("datetime", ["updated_at", "updatedAt", "modified", "last_modified", "modified_at", "date_modified", "update_time", "changed_at"], datetime, 0.8),
  S("datetime", ["deleted_at", "deletedAt", "archived_at", "removed_at"], datetime, 0.25),
];

const TEMPLATES: { tables: string[]; slots: Slot[] }[] = [
  {
    tables: ["users", "user", "accounts", "members", "app_user", "auth_user", "customers", "customer", "clients", "subscribers", "patients", "students", "contacts", "people", "persons", "guests", "players", "drivers", "applicants"],
    slots: [
      ...PERSON_NAME,
      S("full_name", ["full_name", "display_name", "name", "contact_name", "person_name"], () => text(pick([100, 120, 255])), 0.35),
      ...CONTACT,
      S("username", ["username", "user_name", "login", "handle", "screen_name", "nickname", "login_name"], () => text(pick([30, 50, 150])), 0.6),
      S("password_hash", ["password", "password_hash", "passwd", "pwd_hash", "encrypted_password", "hashed_password", "pass_hash"], () => text(pick([60, 128, 255])), 0.6),
      S("birth_date", ["birth_date", "date_of_birth", "dob", "birthday", "birthdate", "born_on"], date, 0.5),
      S("age", ["age"], () => integer(2), 0.1),
      S("status", ["gender", "sex"], () => pick([char(1), text(10), enumOf(["male", "female", "other"])]), 0.4),
      S("boolean", ["is_active", "active", "enabled", "is_verified", "email_verified", "is_staff", "is_admin", "verified", "is_blocked", "banned", "opt_in", "marketing_opt_in", "newsletter"], () => (chance(0.3) ? flagLike() : bool()), 0.9),
      S("boolean", ["is_superuser", "two_factor_enabled", "mfa_enabled", "accepts_marketing"], bool, 0.3),
      S("datetime", ["last_login", "last_login_at", "last_seen_at", "last_active_at", "last_sign_in_at", "email_verified_at", "confirmed_at"], datetime, 0.7),
      S("ip_address", ["last_login_ip", "last_ip", "signup_ip", "current_sign_in_ip", "registration_ip", "ip_address"], () => pick([text(45), text(39), { type: "text", raw: "inet" } as T]), 0.4),
      S("language_code", ["locale", "language", "preferred_language", "lang"], () => text(pick([5, 8, 10, 16])), 0.5),
      S("timezone", ["timezone", "time_zone", "tz", "tz_name"], () => text(pick([32, 50, 64])), 0.5),
      S("url", ["avatar_url", "avatar", "photo_url", "profile_image", "picture_url", "image_url", "website"], () => text(pick([255, 500, 1024])), 0.5),
      S("description", ["bio", "about", "about_me", "notes", "biography"], longText, 0.4),
      S("token", ["remember_token", "reset_token", "password_reset_token", "confirmation_token", "api_token", "auth_token", "refresh_token", "otp_secret", "mfa_secret"], () => text(pick([64, 100, 128, 255])), 0.5),
      S("national_id", ["ssn", "national_id", "tax_id", "passport_number", "id_number", "tin"], () => text(pick([11, 20, 32])), 0.15),
      S("national_id_lk", ["nic", "nic_no", "nic_number"], () => text(12), 0.05),
      S("count", ["login_count", "sign_in_count", "failed_attempts", "failed_login_attempts", "num_logins", "visit_count"], () => integer(4), 0.4),
      S("company", ["company", "company_name", "organization", "employer"], () => text(pick([100, 255])), 0.3),
      S("job_title", ["job_title", "title", "position", "occupation", "designation"], () => text(pick([50, 100])), 0.25),
      S("status", ["status", "role", "user_type", "account_type", "tier", "plan", "membership_level"], () => pick([text(20), text(32), enumOf(["active", "inactive", "pending"])]), 0.6),
      S("json", ["preferences", "settings", "metadata", "profile_data", "extra"], () => (chance(0.4) ? longText() : json()), 0.4),
      S("color", ["favorite_color", "theme_color", "accent_color"], () => text(7), 0.1),
      S("status", ["theme", "ui_theme", "color_scheme"], () => text(10), 0.15),
      ...ADDRESS.map((s) => ({ ...s, p: 0.4 })),
      ...AUDIT,
    ],
  },
  {
    tables: ["employees", "employee", "staff", "hr_employee", "workers", "team_members", "agents", "instructors", "teachers", "doctors"],
    slots: [
      ...PERSON_NAME,
      ...CONTACT,
      S("job_title", ["title", "job_title", "position", "designation", "role_title", "occupation"], () => text(pick([30, 50, 100]))),
      S("date", ["hire_date", "hired_on", "start_date", "joining_date", "date_hired", "employment_start"], date),
      S("date", ["termination_date", "end_date", "leaving_date"], date, 0.4),
      S("birth_date", ["birth_date", "dob", "date_of_birth"], () => pick([date(), datetime()]), 0.6),
      S("money", ["salary", "annual_salary", "base_pay", "hourly_rate", "wage", "monthly_salary", "pay_rate"], () => pick([decimal(10, 2), decimal(12, 2), integer(4)])),
      S("percent", ["commission_pct", "commission_rate", "bonus_percent", "tax_rate", "utilization"], () => decimal(5, 2), 0.4),
      S("status", ["department", "dept", "employment_type", "grade", "level", "band", "shift"], () => text(pick([20, 30, 50])), 0.6),
      S("national_id", ["ssn", "national_id", "employee_ssn", "nin", "tax_id"], () => text(pick([11, 20])), 0.3),
      S("code", ["employee_code", "emp_no", "staff_number", "badge_number", "employee_number", "payroll_ref"], () => text(pick([8, 10, 12, 20])), 0.5),
      S("boolean", ["is_manager", "active", "is_active", "is_contractor", "remote", "full_time"], () => (chance(0.35) ? flagLike() : bool()), 0.7),
      S("url", ["photo_url", "headshot", "profile_photo"], () => text(255), 0.3),
      ...ADDRESS.map((s) => ({ ...s, p: 0.5 })),
      ...AUDIT,
    ],
  },
  {
    tables: ["companies", "company", "organizations", "organisations", "orgs", "vendors", "suppliers", "merchants", "tenants", "partners", "brands", "workspaces", "teams", "accounts_org", "agencies", "manufacturers", "carriers"],
    slots: [
      S("company", ["name", "company_name", "legal_name", "org_name", "vendor_name", "trading_name", "business_name", "display_name"], () => text(pick([100, 150, 200, 255]))),
      S("domain", ["domain", "website_domain", "email_domain", "primary_domain", "hostname", "custom_domain"], () => text(pick([100, 253, 255])), 0.5),
      S("url", ["website", "homepage", "url", "website_url", "logo_url", "logo"], () => text(pick([255, 500])), 0.7),
      S("email", ["billing_email", "contact_email", "support_email", "email"], () => text(254), 0.6),
      S("phone", ["phone", "main_phone", "contact_phone", "fax"], () => text(24), 0.5),
      S("code", ["vat_number", "tax_number", "registration_number", "duns", "company_number", "ein", "gst_no"], () => text(pick([12, 20, 32])), 0.4),
      S("slug", ["slug", "handle", "subdomain", "url_key"], () => text(pick([64, 100])), 0.5),
      S("status", ["industry", "sector", "segment", "size", "company_size", "plan", "tier", "type", "status"], () => text(pick([20, 50])), 0.7),
      S("count", ["employee_count", "headcount", "num_employees", "seat_count", "member_count", "user_count"], () => integer(4), 0.4),
      S("money", ["annual_revenue", "credit_limit", "balance", "mrr", "arr"], () => decimal(14, 2), 0.3),
      S("year", ["founded_year", "year_founded", "established", "founded"], () => integer(2), 0.3),
      S("currency_code", ["currency", "default_currency", "billing_currency", "currency_code"], () => char(3), 0.4),
      S("description", ["description", "about", "notes", "summary"], longText, 0.5),
      S("json", ["settings", "metadata", "config", "features", "attributes"], json, 0.4),
      S("token", ["api_key", "secret_key", "webhook_secret", "signing_secret", "access_key", "client_secret"], () => text(pick([64, 128])), 0.3),
      S("code", ["stripe_customer_id", "external_id", "crm_id", "salesforce_id", "hubspot_id", "billing_customer_id", "erp_ref"], () => text(pick([32, 50, 64])), 0.4),
      ...ADDRESS.map((s) => ({ ...s, p: 0.4 })),
      ...AUDIT,
    ],
  },
  {
    tables: ["products", "product", "items", "catalog_items", "skus", "articles", "inventory_items", "listings", "goods", "parts", "books", "courses", "plans", "menu_items", "services", "albums", "tracks", "films", "movies", "games"],
    slots: [
      S("title", ["name", "title", "product_name", "item_name", "display_name", "label", "short_name"], () => text(pick([100, 120, 200, 255]))),
      S("description", ["description", "long_description", "details", "body_html", "summary", "blurb", "short_description", "overview"], longText, 0.8),
      S("sku", ["sku", "item_code", "product_code", "part_number", "barcode", "ean", "upc", "isbn", "gtin", "model_number", "mpn"], () => text(pick([13, 20, 32, 64])), 0.7),
      S("slug", ["slug", "handle", "url_key", "permalink", "seo_slug"], () => text(pick([100, 255])), 0.5),
      S("money", ["price", "unit_price", "list_price", "cost", "unit_cost", "msrp", "sale_price", "retail_price", "wholesale_price", "price_amount", "base_price", "amount"], () => pick([decimal(10, 2), decimal(12, 2), decimal(19, 4), integer(4)])),
      S("money", ["compare_at_price", "discount_price", "shipping_cost", "deposit"], () => decimal(10, 2), 0.4),
      S("currency_code", ["currency", "currency_code", "price_currency", "ccy"], () => pick([char(3), text(3), text(10)]), 0.4),
      S("quantity", ["stock", "quantity", "qty", "stock_qty", "quantity_on_hand", "qty_available", "inventory_quantity", "units_in_stock", "reorder_level", "units_on_order"], () => integer(pick([2, 4])), 0.7),
      S("rating", ["rating", "avg_rating", "stars", "review_score", "average_rating"], () => pick([decimal(3, 2), integer(1), real()]), 0.4),
      S("count", ["review_count", "num_reviews", "view_count", "views", "sold_count", "times_purchased", "download_count", "play_count", "like_count"], () => integer(4), 0.5),
      S("status", ["status", "category", "product_type", "condition", "availability", "visibility", "kind", "genre", "format", "size", "unit"], () => pick([text(20), text(30), enumOf(["draft", "active", "archived"])]), 0.8),
      S("color", ["color", "colour", "color_hex", "hex_color", "swatch"], () => pick([text(7), text(20)]), 0.3),
      S("number", ["weight", "weight_kg", "width", "height", "depth", "length_cm", "volume", "weight_grams"], () => pick([decimal(8, 2), real(), decimal(10, 3)]), 0.5),
      S("integer", ["length", "duration", "runtime", "duration_minutes", "pages", "page_count", "duration_ms", "sort_order", "position", "rank", "display_order"], () => integer(pick([2, 4])), 0.5),
      S("year", ["release_year", "year", "model_year", "publication_year", "year_published"], () => integer(2), 0.3),
      S("date", ["release_date", "available_from", "launch_date", "published_date", "available_on"], date, 0.4),
      S("percent", ["tax_rate", "discount_percent", "vat_rate", "margin_pct", "markup_percent"], () => decimal(5, 2), 0.3),
      S("url", ["image_url", "thumbnail_url", "image", "photo", "thumbnail", "cover_url", "preview_url", "product_url"], () => text(pick([255, 500, 1024])), 0.6),
      S("boolean", ["is_active", "active", "in_stock", "is_featured", "featured", "taxable", "discontinued", "is_digital", "published", "requires_shipping", "is_available"], () => (chance(0.3) ? flagLike() : bool()), 0.8),
      S("full_name", ["author", "author_name", "director", "artist_name", "designer", "brand_owner", "narrator", "instructor_name"], () => text(pick([100, 200, 220])), 0.3),
      S("company", ["brand", "manufacturer", "vendor", "publisher", "supplier_name", "label_name", "studio"], () => text(pick([100, 120])), 0.3),
      S("json", ["attributes", "specs", "metadata", "options", "variants", "dimensions", "custom_fields"], () => (chance(0.3) ? longText() : json()), 0.4),
      S("language_code", ["language", "lang", "original_language"], () => text(pick([5, 8, 20])), 0.15),
      S("bytes", ["image_data", "thumbnail_blob", "picture"], bytes, 0.1),
      ...AUDIT,
    ],
  },
  {
    tables: ["orders", "order", "sales_orders", "purchases", "invoices", "invoice", "bills", "carts", "quotes", "bookings", "reservations", "rentals", "transactions", "payments", "refunds", "payouts", "charges", "receipts"],
    slots: [
      S("code", ["order_number", "invoice_number", "reference", "ref", "order_no", "confirmation_code", "booking_ref", "receipt_number", "po_number", "invoice_no", "txn_ref", "transaction_ref"], () => text(pick([12, 20, 32, 50])), 0.7),
      S("money", ["total", "total_amount", "amount", "grand_total", "subtotal", "amount_due", "amount_paid", "order_total", "net_amount", "gross_amount", "total_price", "amt", "total_amt"], () => pick([decimal(10, 2), decimal(12, 2), decimal(19, 4), integer(8)])),
      S("money", ["tax", "tax_amount", "vat", "shipping", "shipping_fee", "discount", "discount_amount", "tip", "fee", "service_fee", "balance_due", "refund_amount", "freight"], () => decimal(10, 2), 0.6),
      S("money", ["amount_cents", "total_cents", "price_cents", "amount_in_cents"], () => integer(8), 0.2),
      S("currency_code", ["currency", "currency_code", "ccy", "iso_currency"], () => pick([char(3), text(3), text(10)]), 0.6),
      S("percent", ["tax_rate", "discount_rate", "vat_percent", "discount_pct"], () => decimal(5, 2), 0.3),
      S("status", ["status", "order_status", "payment_status", "fulfillment_status", "state", "payment_method", "channel", "source", "type", "kind", "shipping_method", "delivery_method", "card_brand"], () => pick([text(20), text(30), enumOf(["pending", "paid", "shipped", "cancelled"])]), 0.9),
      S("datetime", ["ordered_at", "order_date", "placed_at", "paid_at", "payment_date", "transaction_date", "shipped_at", "shipped_date", "delivered_at", "cancelled_at", "refunded_at", "captured_at", "processed_at", "rental_date", "return_date", "checked_in_at", "checked_out_at", "booked_at"], datetime, 0.9),
      S("date", ["due_date", "invoice_date", "issue_date", "service_date", "delivery_date", "check_in", "check_out", "period_start", "period_end", "billing_date", "expected_date", "required_date"], date, 0.7),
      S("description", ["notes", "note", "comments", "customer_note", "special_instructions", "memo", "remarks", "internal_notes"], longText, 0.5),
      S("ip_address", ["ip_address", "customer_ip", "client_ip", "remote_ip", "browser_ip"], () => text(45), 0.3),
      S("text", ["user_agent", "customer_user_agent", "browser_user_agent"], () => text(pick([255, 512])), 0.2),
      S("code", ["stripe_payment_intent_id", "charge_id", "gateway_transaction_id", "paypal_order_id", "processor_id", "external_ref", "authorization_code", "psp_reference"], () => text(pick([32, 64, 100])), 0.4),
      S("code", ["card_last4", "last4", "last_four"], () => char(4), 0.2),
      S("quantity", ["item_count", "total_items", "num_items", "guests", "party_size", "seats", "nights"], () => integer(2), 0.3),
      S("json", ["metadata", "line_items", "payload", "billing_details", "gateway_response", "extra_data"], () => (chance(0.3) ? longText() : json()), 0.4),
      S("boolean", ["is_paid", "paid", "is_gift", "gift", "is_refunded", "test_mode", "livemode", "is_recurring"], () => (chance(0.3) ? flagLike() : bool()), 0.5),
      S("full_name", ["billing_name", "shipping_name", "recipient_name", "customer_name", "ship_to_name", "cardholder_name"], () => text(pick([100, 120])), 0.4),
      S("email", ["customer_email", "billing_email", "receipt_email", "email"], () => text(254), 0.4),
      S("phone", ["shipping_phone", "billing_phone", "contact_phone"], () => text(24), 0.2),
      S("street", ["billing_address", "shipping_address", "ship_address", "billing_street", "ship_to_address"], () => text(pick([70, 255])), 0.4),
      S("city", ["billing_city", "shipping_city", "ship_city"], () => text(40), 0.3),
      S("region", ["billing_state", "shipping_state", "ship_region"], () => text(40), 0.3),
      S("postal_code", ["billing_postal_code", "shipping_zip", "ship_postal_code", "billing_zip"], () => text(10), 0.3),
      S("country_code", ["billing_country", "shipping_country", "ship_country"], () => char(2), 0.3),
      ...AUDIT,
    ],
  },
  {
    tables: ["order_items", "order_lines", "invoice_lines", "line_items", "cart_items", "order_details", "purchase_order_lines", "shipment_items"],
    slots: [
      S("quantity", ["quantity", "qty", "units", "quantity_ordered", "qty_shipped", "amount_units", "ordered_qty"], () => pick([integer(2), integer(4), decimal(10, 2)])),
      S("money", ["unit_price", "price", "line_total", "total", "amount", "unit_cost", "extended_price", "price_each", "subtotal"], () => pick([decimal(10, 2), decimal(12, 4)])),
      S("money", ["discount", "discount_amount", "tax_amount", "line_discount"], () => decimal(10, 2), 0.5),
      S("percent", ["discount_percent", "tax_rate", "discount_pct", "vat_rate"], () => decimal(5, 2), 0.3),
      S("title", ["description", "product_name", "item_name", "name", "title"], () => text(pick([100, 200, 255])), 0.5),
      S("sku", ["sku", "product_code", "item_code", "part_no"], () => text(pick([20, 32])), 0.4),
      S("integer", ["line_number", "line_no", "position", "sort_order", "seq"], () => integer(2), 0.4),
      ...AUDIT.slice(0, 1),
    ],
  },
  {
    tables: ["events", "analytics_events", "page_views", "pageviews", "sessions", "visits", "clicks", "tracking_events", "audit_logs", "activity_log", "logs", "request_logs", "access_logs", "login_history", "impressions", "web_events"],
    slots: [
      S("status", ["event_type", "event_name", "action", "event", "type", "kind", "category", "verb", "activity_type", "level", "severity", "log_level", "channel"], () => pick([text(50), text(64), text(100), integer(2)])),
      S("datetime", ["occurred_at", "timestamp", "ts", "event_time", "created_at", "logged_at", "time", "recorded_at", "started_at", "ended_at", "received_at"], datetime),
      S("ip_address", ["ip", "ip_address", "client_ip", "remote_addr", "source_ip", "user_ip"], () => pick([text(45), text(39), { type: "text", raw: "inet" } as T]), 0.7),
      S("text", ["user_agent", "ua", "useragent", "agent_string"], () => text(pick([255, 512, 1000])), 0.6),
      S("status", ["browser", "browser_name", "os", "os_name", "platform", "device", "device_type", "client", "app_version_name", "environment", "env", "viewport", "connection_type"], () => text(pick([20, 32, 50])), 0.7),
      S("url", ["url", "page_url", "full_url", "referrer", "referer", "referrer_url", "landing_page", "request_url", "target_url"], () => text(pick([500, 1024, 2048])), 0.7),
      S("file_path", ["path", "page_path", "request_path", "pathname", "route", "endpoint"], () => text(pick([255, 500])), 0.5),
      S("domain", ["host", "hostname", "referrer_host", "referring_domain", "domain", "origin_host"], () => text(pick([100, 255])), 0.4),
      S("text", ["query_string", "querystring", "search_query", "url_params", "request_query"], () => text(pick([500, 1000])), 0.3),
      S("status", ["source", "medium", "traffic_source", "acquisition_channel"], () => text(pick([100, 255])), 0.4),
      S("title", ["campaign", "campaign_name", "page_title", "screen_name", "document_title"], () => text(pick([255, 500])), 0.4),
      S("status", ["method", "http_method", "request_method", "verb"], () => text(10), 0.3),
      S("integer", ["status_code", "http_status", "response_code", "exit_code", "error_code"], () => integer(2), 0.3),
      S("integer", ["duration_ms", "latency_ms", "response_time", "elapsed_ms", "bytes_sent", "response_size", "content_length", "x", "y", "scroll_depth_px", "screen_width", "screen_height", "viewport_width"], () => integer(4), 0.5),
      S("number", ["duration", "load_time", "time_on_page", "elapsed_seconds", "score", "value"], () => pick([decimal(10, 3), real()]), 0.3),
      S("percent", ["scroll_depth", "scroll_percent", "progress", "completion_pct", "bounce_rate"], () => pick([integer(2), decimal(5, 2)]), 0.2),
      S("uuid", ["session_id", "visitor_id", "anonymous_id", "device_id", "request_id", "trace_id", "correlation_id", "event_id"], uuid, 0.6),
      S("code", ["session_key", "visitor_key", "cookie_id", "client_id", "anon_id", "fingerprint_id", "tracking_code"], () => text(pick([32, 50, 64])), 0.4),
      S("token", ["click_id", "session_token", "csrf_token", "jwt", "nonce"], () => text(pick([128, 255, 512])), 0.3),
      S("description", ["message", "description", "details", "summary", "comment"], longText, 0.4),
      S("text", ["stack_trace", "stacktrace", "traceback", "backtrace", "error_details", "raw_log", "sql", "query"], longText, 0.3),
      S("json", ["properties", "payload", "data", "context", "metadata", "params", "extra", "changes", "old_values", "new_values", "headers", "attributes", "event_properties"], () => (chance(0.25) ? longText() : json()), 0.7),
      S("country_code", ["country", "country_code", "geo_country"], () => char(2), 0.4),
      S("region", ["region", "geo_region", "subdivision", "state"], () => text(50), 0.3),
      S("city", ["city", "geo_city"], () => text(50), 0.3),
      S("latitude", ["lat", "latitude", "geo_lat"], () => pick([decimal(9, 6), real()]), 0.2),
      S("longitude", ["lng", "lon", "longitude", "geo_lng"], () => pick([decimal(9, 6), real()]), 0.2),
      S("language_code", ["language", "locale", "browser_language", "lang"], () => text(pick([10, 16, 35])), 0.3),
      S("code", ["app_version", "version", "release", "build", "sdk_version", "client_version", "build_number"], () => text(pick([20, 32, 50])), 0.3),
      S("count", ["count", "event_count", "hits", "page_count", "retry_count", "attempt", "attempts", "occurrences", "num_events"], () => integer(4), 0.3),
      S("boolean", ["is_bot", "bounced", "is_mobile", "is_new_visitor", "success", "succeeded", "is_error"], bool, 0.4),
      S("token", ["fingerprint", "hash", "checksum", "event_hash", "dedupe_key", "signature", "digest"], () => text(pick([40, 64, 128])), 0.2),
    ],
  },
  {
    tables: ["api_keys", "access_tokens", "oauth_tokens", "personal_access_tokens", "webhooks", "integrations", "credentials", "sessions_auth", "password_resets", "otp_codes", "two_factor", "devices", "push_subscriptions", "connected_accounts", "oauth_clients", "secrets"],
    slots: [
      S("title", ["name", "label", "description", "key_name", "token_name", "nickname"], () => text(pick([100, 255])), 0.6),
      S("token", ["token", "key", "api_key", "secret", "token_hash", "hashed_token", "access_token", "refresh_token", "client_secret", "secret_key", "signing_secret", "webhook_secret", "private_key", "encrypted_key", "digest", "auth_key", "endpoint_secret", "push_token", "device_token"], () => text(pick([64, 128, 255, 512]))),
      S("code", ["prefix", "token_prefix", "last_four", "hint", "short_code"], () => text(pick([8, 12, 16])), 0.5),
      S("code", ["otp", "otp_code", "verification_code", "pin", "code", "backup_code", "recovery_code"], () => text(pick([6, 8, 10])), 0.4),
      S("code", ["client_id", "app_id", "key_id", "external_account_id", "provider_account_id", "provider_user_id", "account_ref"], () => text(pick([32, 64, 100])), 0.5),
      S("status", ["provider", "scope", "scopes", "type", "token_type", "kind", "platform", "grant_type", "status", "auth_method"], () => text(pick([20, 50, 100])), 0.6),
      S("url", ["url", "callback_url", "redirect_uri", "endpoint", "webhook_url", "target_url", "endpoint_url"], () => text(pick([500, 1024, 2048])), 0.5),
      S("datetime", ["expires_at", "expires", "last_used_at", "last_used", "revoked_at", "rotated_at", "verified_at", "locked_until", "valid_until", "not_before"], datetime, 0.9),
      S("count", ["usage_count", "use_count", "failed_attempts", "attempts", "times_used", "delivery_attempts"], () => integer(4), 0.4),
      S("ip_address", ["ip_address", "last_used_ip", "created_from_ip"], () => text(45), 0.3),
      S("text", ["user_agent", "last_user_agent"], () => text(255), 0.2),
      S("boolean", ["revoked", "is_active", "enabled", "active", "is_enabled", "used", "is_read_only", "confirmed"], () => (chance(0.3) ? flagLike() : bool()), 0.6),
      S("json", ["abilities", "permissions", "scopes_json", "events", "headers", "config", "settings"], () => (chance(0.4) ? longText() : json()), 0.4),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["posts", "articles", "blog_posts", "pages", "comments", "reviews", "messages", "notes", "tickets", "issues", "tasks", "documents", "announcements", "faqs", "questions", "answers", "threads", "notifications", "emails", "chat_messages"],
    slots: [
      S("title", ["title", "subject", "headline", "name", "heading", "topic"], () => text(pick([150, 200, 255, 500])), 0.8),
      S("description", ["body", "content", "text", "message", "description", "body_text", "excerpt", "summary", "comment", "answer", "question", "details", "body_markdown", "content_html"], longText),
      S("slug", ["slug", "permalink", "url_slug", "seo_slug"], () => text(pick([200, 255])), 0.4),
      S("status", ["status", "state", "visibility", "priority", "severity", "type", "category", "kind", "resolution", "channel", "post_type", "format", "role", "sentiment"], () => pick([text(20), enumOf(["draft", "published", "archived"]), integer(2)]), 0.8),
      S("rating", ["rating", "stars", "score", "review_rating"], () => integer(1), 0.3),
      S("count", ["views", "view_count", "likes", "like_count", "comment_count", "reply_count", "upvotes", "downvotes", "share_count", "read_count", "helpful_count", "votes"], () => integer(4), 0.6),
      S("datetime", ["published_at", "posted_at", "sent_at", "read_at", "resolved_at", "closed_at", "answered_at", "edited_at", "scheduled_for", "delivered_at", "seen_at"], datetime, 0.8),
      S("date", ["due_date", "due_on", "deadline", "target_date"], date, 0.3),
      S("boolean", ["is_published", "published", "pinned", "is_pinned", "is_read", "read", "locked", "is_spam", "approved", "is_public", "featured", "is_private", "is_edited"], () => (chance(0.3) ? flagLike() : bool()), 0.7),
      S("url", ["cover_image", "featured_image", "image_url", "canonical_url", "link", "attachment_url", "thumbnail"], () => text(pick([255, 500])), 0.4),
      S("json", ["tags", "metadata", "attachments", "mentions", "reactions", "blocks", "meta"], () => (chance(0.35) ? longText() : json()), 0.4),
      S("text", ["tags_text", "keywords", "tag_list", "search_vector", "raw_html"], () => text(pick([255, 500])), 0.2),
      S("language_code", ["language", "lang", "locale"], () => text(pick([5, 10])), 0.2),
      S("full_name", ["author_name", "author", "commenter_name", "sender_name", "reporter_name", "byline", "reviewer_name"], () => text(100), 0.3),
      S("email", ["author_email", "commenter_email", "sender_email", "from_email", "to_email", "reply_to"], () => text(254), 0.3),
      S("integer", ["sort_order", "position", "order", "menu_order", "depth", "level_depth", "reading_time"], () => integer(2), 0.3),
      S("ip_address", ["author_ip", "ip", "commenter_ip"], () => text(45), 0.2),
      ...AUDIT,
    ],
  },
  {
    tables: ["addresses", "address", "locations", "stores", "warehouses", "branches", "offices", "sites", "venues", "properties", "shipping_addresses", "facilities", "places", "airports", "hotels"],
    slots: [
      S("title", ["name", "label", "location_name", "store_name", "site_name", "venue_name", "nickname"], () => text(pick([100, 120, 200])), 0.6),
      ...ADDRESS,
      S("address", ["full_address", "formatted_address", "address_text", "location", "address_full"], () => text(pick([255, 500])), 0.3),
      S("latitude", ["lat", "latitude", "geo_lat", "location_lat", "lat_deg"], () => pick([decimal(9, 6), decimal(10, 7), real()]), 0.6),
      S("longitude", ["lng", "lon", "longitude", "geo_lng", "long", "location_lng"], () => pick([decimal(9, 6), decimal(10, 7), real()]), 0.6),
      S("phone", ["phone", "phone_number", "contact_number", "fax"], () => text(24), 0.5),
      S("timezone", ["timezone", "time_zone", "tz", "iana_timezone"], () => text(pick([40, 64])), 0.3),
      S("status", ["type", "address_type", "kind", "location_type", "category", "status"], () => text(20), 0.5),
      S("boolean", ["is_default", "is_primary", "is_billing", "is_shipping", "active", "is_open", "verified"], () => (chance(0.3) ? flagLike() : bool()), 0.5),
      S("time", ["opens_at", "closes_at", "open_time", "close_time", "opening_time", "closing_time", "check_in_time"], time, 0.3),
      S("quantity", ["capacity", "rooms", "num_rooms", "beds", "parking_spaces", "dock_doors"], () => integer(4), 0.3),
      S("number", ["area_sqft", "square_meters", "floor_area", "elevation", "acreage"], () => pick([decimal(10, 2), real()]), 0.2),
      S("code", ["store_code", "location_code", "site_code", "branch_code", "iata_code", "gln", "warehouse_code"], () => text(pick([4, 6, 10, 12])), 0.4),
      S("description", ["directions", "instructions", "delivery_instructions", "notes", "access_notes"], longText, 0.3),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["files", "attachments", "uploads", "media", "images", "documents_files", "assets", "photos", "videos", "backups", "exports", "imports"],
    slots: [
      S("file_path", ["path", "file_path", "storage_path", "key", "object_key", "s3_key", "storage_key", "blob_path", "filename", "file_name", "disk_path", "relative_path"], () => text(pick([255, 500, 1024]))),
      S("title", ["original_name", "original_filename", "display_name", "name", "title", "caption"], () => text(255), 0.6),
      S("mime_type", ["mime_type", "content_type", "mimetype", "media_type", "file_type_mime"], () => text(pick([100, 127, 255])), 0.8),
      S("integer", ["size", "file_size", "size_bytes", "byte_size", "bytes", "filesize", "width", "height", "duration_seconds", "page_count", "bitrate"], () => integer(8), 0.8),
      S("token", ["checksum", "sha256", "md5", "etag", "hash", "content_hash", "digest", "sha1"], () => text(pick([32, 40, 64])), 0.5),
      S("url", ["url", "public_url", "cdn_url", "download_url", "thumbnail_url", "preview_url", "source_url", "signed_url"], () => text(pick([500, 1024, 2048])), 0.6),
      S("status", ["disk", "storage", "bucket", "provider", "visibility", "kind", "type", "status", "variant", "collection", "conversion"], () => text(pick([20, 50, 64])), 0.6),
      S("bytes", ["data", "content", "blob", "file_data", "thumbnail", "binary"], bytes, 0.2),
      S("json", ["metadata", "exif", "custom_properties", "variants", "dimensions", "manipulations", "responsive_images"], json, 0.4),
      S("title", ["alt", "alt_text"], () => text(255), 0.3),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["subscriptions", "memberships", "licenses", "contracts", "policies", "plans_subscribed", "enrollments", "accounts_billing", "loans", "leases", "warranties"],
    slots: [
      S("status", ["status", "plan", "plan_code", "tier", "billing_cycle", "interval", "billing_interval", "type", "product", "cancel_reason", "seat_type", "level"], () => pick([text(20), text(32), enumOf(["active", "trialing", "canceled", "past_due"])]), 0.9),
      S("title", ["plan_name", "product_name", "name", "package_name"], () => text(pick([50, 100])), 0.4),
      S("money", ["price", "amount", "monthly_price", "annual_price", "mrr", "premium", "principal", "monthly_payment", "rate_amount", "balance", "setup_fee"], () => decimal(10, 2), 0.7),
      S("percent", ["interest_rate", "apr", "discount_percent", "renewal_discount", "churn_probability", "coverage_pct"], () => decimal(5, 2), 0.3),
      S("currency_code", ["currency", "currency_code"], () => char(3), 0.4),
      S("date", ["start_date", "end_date", "renewal_date", "next_billing_date", "trial_end_date", "effective_date", "expiry_date", "maturity_date", "issue_date", "term_start", "term_end"], date, 0.9),
      S("datetime", ["current_period_start", "current_period_end", "trial_ends_at", "canceled_at", "cancelled_at", "ends_at", "renewed_at", "paused_at", "activated_at"], datetime, 0.8),
      S("quantity", ["seats", "quantity", "licenses", "seat_limit", "max_users", "units"], () => integer(4), 0.5),
      S("integer", ["term_months", "duration_months", "trial_days", "grace_period_days", "billing_day", "max_projects", "storage_limit_gb", "api_rate_limit"], () => integer(4), 0.4),
      S("boolean", ["auto_renew", "cancel_at_period_end", "is_trial", "active", "paused", "is_annual"], () => (chance(0.3) ? flagLike() : bool()), 0.6),
      S("code", ["stripe_subscription_id", "external_id", "subscription_ref", "contract_number", "policy_number", "license_key_id", "gateway_subscription_id", "braintree_id", "paddle_id", "loan_number"], () => text(pick([20, 32, 64])), 0.6),
      S("token", ["license_key", "payment_method_token", "card_token", "vault_token"], () => text(pick([64, 128])), 0.3),
      S("email", ["billing_email", "notification_email"], () => text(254), 0.3),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["shipments", "deliveries", "parcels", "trips", "rides", "flights", "routes", "vehicles", "fleet", "tracking", "consignments"],
    slots: [
      S("code", ["tracking_number", "tracking_no", "awb", "waybill", "consignment_no", "flight_number", "license_plate", "vin", "plate_number", "registration", "pnr", "booking_code"], () => text(pick([12, 17, 20, 32])), 0.8),
      S("status", ["status", "carrier", "service_level", "shipping_method", "vehicle_type", "fuel_type", "make", "transmission", "mode", "class", "cabin_class"], () => text(pick([20, 40])), 0.9),
      S("title", ["model", "vehicle_model", "route_name", "name"], () => text(50), 0.3),
      S("datetime", ["shipped_at", "delivered_at", "picked_up_at", "eta", "estimated_delivery", "departure_time", "arrival_time", "dispatched_at", "departs_at", "arrives_at", "last_scan_at"], datetime, 0.9),
      S("number", ["weight", "weight_kg", "distance_km", "distance", "mileage", "odometer", "fuel_level", "volume_m3", "length_m"], () => pick([decimal(10, 2), real()]), 0.7),
      S("money", ["shipping_cost", "fare", "price", "cost", "toll", "fuel_cost", "insured_value", "declared_value"], () => decimal(10, 2), 0.6),
      S("latitude", ["pickup_lat", "dropoff_lat", "current_lat", "origin_lat", "lat"], () => decimal(9, 6), 0.4),
      S("longitude", ["pickup_lng", "dropoff_lng", "current_lng", "origin_lng", "lng"], () => decimal(9, 6), 0.4),
      S("year", ["year", "model_year", "manufacture_year", "year_built"], () => integer(2), 0.3),
      S("color", ["color", "colour", "paint_color"], () => text(20), 0.2),
      S("quantity", ["package_count", "pieces", "num_packages", "passengers", "seats", "capacity"], () => integer(2), 0.4),
      S("street", ["origin_address", "destination_address", "pickup_address", "dropoff_address", "delivery_address"], () => text(255), 0.4),
      S("city", ["origin_city", "destination_city", "pickup_city"], () => text(60), 0.3),
      S("country_code", ["origin_country", "destination_country"], () => char(2), 0.3),
      S("code", ["origin", "destination", "from_airport", "to_airport", "origin_code", "dest_code"], () => char(3), 0.2),
      S("full_name", ["driver_name", "recipient", "signed_by", "receiver_name", "consignee", "pilot_name"], () => text(100), 0.3),
      S("url", ["tracking_url", "label_url", "proof_of_delivery_url"], () => text(500), 0.3),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["settings", "app_settings", "config", "configuration", "feature_flags", "options", "preferences", "parameters", "system_settings", "site_config", "translations", "lookups", "enums", "country", "countries", "currencies", "languages", "categories", "tags", "genres", "departments", "roles", "permissions", "statuses", "units"],
    slots: [
      S("code", ["key", "setting_key", "name_key", "option_name", "flag_key", "config_key", "code", "slug_key", "param_name"], () => text(pick([64, 100, 128, 191])), 0.6),
      S("text", ["value", "setting_value", "option_value", "config_value", "param_value", "default_value"], longText, 0.6),
      S("title", ["name", "label", "display_name", "title", "category_name", "tag_name", "role_name", "dept_name"], () => text(pick([50, 100, 120])), 0.7),
      S("description", ["description", "help_text", "notes", "explanation"], longText, 0.4),
      S("status", ["type", "value_type", "data_type", "group", "scope", "kind", "environment", "section"], () => text(pick([20, 32])), 0.5),
      S("boolean", ["enabled", "is_enabled", "active", "autoload", "is_public", "is_system", "is_default", "rollout"], () => (chance(0.4) ? flagLike() : bool()), 0.6),
      S("percent", ["rollout_percentage", "rollout_pct", "percentage", "weight_pct"], () => integer(2), 0.2),
      S("integer", ["sort_order", "position", "display_order", "rank", "lft", "rgt", "depth"], () => integer(2), 0.4),
      S("slug", ["slug", "handle", "url_slug"], () => text(100), 0.3),
      S("color", ["color", "colour", "hex_color", "badge_color", "bg_color"], () => pick([text(7), char(7), text(20)]), 0.3),
      S("country_code", ["iso2", "iso_code", "alpha2", "country_code", "iso_alpha_2"], () => char(2), 0.15),
      S("code", ["iso3", "alpha3", "iso_alpha_3", "currency_code_num", "numeric_code"], () => char(3), 0.1),
      S("currency_code", ["currency_code", "iso_currency", "currency"], () => char(3), 0.1),
      S("language_code", ["locale", "language_code", "lang_code", "iso639"], () => text(pick([2, 5, 8])), 0.15),
      S("json", ["value_json", "options", "metadata", "rules", "conditions", "variants", "payload", "schema"], () => (chance(0.4) ? longText() : json()), 0.4),
      S("url", ["icon_url", "icon", "image", "flag_url"], () => text(255), 0.2),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["jobs", "queue_jobs", "failed_jobs", "scheduled_tasks", "cron_jobs", "migrations", "background_jobs", "batches", "workflow_runs", "pipelines", "builds", "deployments", "runs", "checks", "monitors", "health_checks", "alerts", "incidents"],
    slots: [
      S("title", ["name", "job_name", "task_name", "display_name", "title", "workflow_name", "check_name"], () => text(pick([100, 191, 255])), 0.6),
      S("status", ["status", "state", "queue", "priority", "result", "conclusion", "trigger", "event", "kind", "type", "environment", "runner", "severity", "outcome", "connection", "branch"], () => pick([text(20), text(50), enumOf(["queued", "running", "succeeded", "failed"])]), 0.9),
      S("text", ["exception", "error", "error_message", "last_error", "failure_reason", "output", "log", "stderr", "stdout", "traceback", "logs"], longText, 0.6),
      S("json", ["payload", "args", "arguments", "kwargs", "options", "result", "context", "inputs", "outputs", "env", "matrix"], () => (chance(0.4) ? longText() : json()), 0.7),
      S("text", ["schedule", "cron", "cron_expression", "rrule", "recurrence"], () => text(100), 0.3),
      S("text", ["timeout", "interval", "retry_delay", "grace_period", "backoff"], () => ({ type: "text", raw: "interval" }), 0.2),
      S("count", ["attempts", "attempt", "retries", "retry_count", "run_count", "failure_count", "times_run", "num_failures", "consecutive_failures"], () => integer(2), 0.6),
      S("integer", ["max_attempts", "timeout_seconds", "duration_ms", "exit_code", "pid", "batch_size", "total_jobs", "pending_jobs", "run_number", "progress_step", "sequence"], () => integer(4), 0.5),
      S("percent", ["progress", "percent_complete", "progress_pct", "success_rate", "uptime_pct"], () => pick([integer(2), decimal(5, 2)]), 0.3),
      S("datetime", ["available_at", "reserved_at", "failed_at", "started_at", "finished_at", "completed_at", "scheduled_at", "run_at", "next_run_at", "last_run_at", "queued_at", "locked_at", "heartbeat_at", "acknowledged_at", "resolved_at"], datetime, 0.9),
      S("uuid", ["uuid", "job_uuid", "run_id", "batch_id", "correlation_id"], uuid, 0.4),
      S("code", ["commit_sha", "git_sha", "revision", "version", "tag", "build_number", "image_tag", "release"], () => text(pick([40, 64, 100])), 0.4),
      S("status", ["git_branch", "ref_name", "region", "cluster", "provider", "host_type"], () => text(100), 0.2),
      S("url", ["url", "log_url", "html_url", "target_url", "callback_url", "webhook_url"], () => text(500), 0.3),
      S("domain", ["host", "hostname", "server", "node", "worker_host"], () => text(255), 0.3),
      S("boolean", ["is_paused", "paused", "enabled", "manual", "is_scheduled", "is_failed", "muted", "acknowledged"], bool, 0.4),
      S("integer", ["batch", "migration_batch"], () => integer(4), 0.1),
      ...AUDIT.slice(0, 2),
    ],
  },
  {
    tables: ["metrics", "measurements", "readings", "sensor_data", "stats", "daily_stats", "kpis", "scores", "grades", "results", "experiments", "observations", "vitals", "transactions_ledger", "balances", "exchange_rates", "prices_history", "stock_quotes"],
    slots: [
      S("date", ["date", "day", "stat_date", "report_date", "as_of_date", "period", "business_date", "trade_date", "observation_date"], date, 0.6),
      S("datetime", ["measured_at", "recorded_at", "timestamp", "ts", "reading_time", "captured_at", "sampled_at", "bucket", "window_start", "window_end"], datetime, 0.6),
      S("number", ["value", "reading", "measurement", "temperature", "humidity", "pressure", "voltage", "speed", "metric_value", "avg_value", "min_value", "max_value", "p95", "mean", "stddev", "bpm", "weight", "height_cm", "bmi", "glucose", "exchange_rate", "fx_rate", "conversion_rate_fx"], () => pick([decimal(12, 4), real(), decimal(10, 2), decimal(10, 1)])),
      S("count", ["count", "visits", "visitors", "unique_visitors", "pageviews", "sessions", "signups", "orders_count", "clicks", "impressions", "conversions", "installs", "active_users", "events", "errors", "num_samples", "sample_count"], () => integer(8), 0.7),
      S("percent", ["conversion_rate", "bounce_rate", "ctr", "churn_rate", "pct", "percent", "share", "growth_rate", "error_rate", "utilization", "accuracy", "battery_level", "completion_rate", "occupancy_rate"], () => pick([decimal(5, 2), decimal(7, 4), real()]), 0.6),
      S("money", ["revenue", "gross_revenue", "net_revenue", "spend", "cost", "profit", "amount", "balance", "open", "close", "high", "low", "price", "market_cap", "debit", "credit", "running_balance"], () => pick([decimal(14, 2), decimal(19, 4)]), 0.6),
      S("rating", ["score", "grade", "rating", "nps", "satisfaction_score", "csat"], () => pick([integer(1), decimal(4, 2)]), 0.3),
      S("status", ["metric", "metric_name", "unit", "sensor_type", "dimension", "granularity", "source", "currency_pair", "symbol", "ticker", "exchange", "grade_letter", "result", "outcome", "variant", "group", "cohort", "subject"], () => text(pick([10, 32, 50])), 0.7),
      S("currency_code", ["currency", "base_currency", "quote_currency", "from_currency", "to_currency"], () => char(3), 0.3),
      S("code", ["sensor_serial", "device_serial", "meter_number", "station_code", "asset_tag"], () => text(pick([16, 32])), 0.3),
      S("integer", ["quantity_traded", "volume", "sample_size", "rank", "position", "bucket_index", "hour", "minute", "week", "month", "quarter", "day_of_week"], () => integer(4), 0.4),
      S("year", ["year", "fiscal_year", "academic_year", "season"], () => integer(2), 0.3),
      S("json", ["breakdown", "dimensions", "tags", "labels", "histogram", "raw"], json, 0.3),
    ],
  },
];

// Column names that need the table's name first in real schemas ("order_status", "customer_email").
const PREFIX_OK = new Set<MeaningId>(["email", "phone", "status", "title", "description", "code", "datetime", "date", "money", "count", "url", "boolean"]);

// ---------------------------------------------------------------- renaming
const ABBREV: Record<string, string[]> = {
  number: ["no", "num", "nbr", "nr"],
  amount: ["amt"],
  quantity: ["qty"],
  address: ["addr", "adr"],
  description: ["desc", "descr"],
  customer: ["cust"],
  account: ["acct"],
  name: ["nm"],
  date: ["dt"],
  timestamp: ["ts"],
  telephone: ["tel"],
  phone: ["ph"],
  message: ["msg"],
  reference: ["ref"],
  identifier: ["id"],
  organization: ["org"],
  password: ["pwd", "pw"],
  department: ["dept"],
  employee: ["emp"],
  transaction: ["txn", "trx"],
  product: ["prod"],
  category: ["cat"],
  configuration: ["config", "cfg"],
  percent: ["pct"],
  count: ["cnt"],
  average: ["avg"],
  maximum: ["max"],
  minimum: ["min"],
  image: ["img"],
  first: ["fst"],
  last: ["lst"],
  total: ["tot"],
  price: ["prc"],
  balance: ["bal"],
  status: ["stat", "sts"],
  type: ["typ"],
  code: ["cd"],
  street: ["st", "str"],
  country: ["ctry", "cntry"],
  currency: ["cur", "curr"],
};

function tableAbbrev(table: string): string {
  const w = table.replace(/s$/, "").split("_");
  const base = w[w.length - 1]!;
  return pick([base, base.slice(0, 3), base.slice(0, 4), w.map((x) => x[0]).join("")]);
}

function style(name: string, table: string, m: MeaningId, convention: number): string {
  let parts = name.split("_");
  if (chance(0.12)) parts = parts.map((p) => (ABBREV[p] && chance(0.7) ? pick(ABBREV[p]!) : p));
  if (PREFIX_OK.has(m) && chance(0.08) && !name.includes(table)) parts = [tableAbbrev(table), ...parts];
  if (chance(0.03)) parts = [pick(["str", "dt", "n", "f", "b", "c", "fld", "col"]), ...parts];
  switch (convention) {
    case 1:
      return parts[0] + parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
    case 2:
      return parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
    case 3:
      return parts.join("_").toUpperCase();
    case 4:
      return parts.join("");
    default:
      return parts.join("_");
  }
}

function tableName(base: string, convention: number): string {
  let t = base;
  if (chance(0.1)) t = `${pick(["app", "tbl", "core", "crm", "shop", "billing", "hr", "erp", "web", "dbo", "public", "sales", "cms", "acct", "ops"])}_${t}`;
  if (chance(0.15)) t = t.endsWith("s") ? t.slice(0, -1) : `${t}s`;
  if (convention === 2) return t.split("_").map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  if (convention === 3) return t.toUpperCase();
  if (convention === 1) return t.split("_").map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p)).join("");
  return t;
}

// ---------------------------------------------------------------- tables
function column(name: string, t: T, extra: Partial<ColumnModel> = {}): ColumnModel {
  const c: ColumnModel = { name, type: t.type, rawType: t.raw, nullable: chance(0.55), primaryKey: false, autoIncrement: false, unique: false, ...extra };
  if (t.maxLength !== undefined) c.maxLength = t.maxLength;
  if (t.precision !== undefined) c.precision = t.precision;
  if (t.scale !== undefined) c.scale = t.scale;
  if (t.intBytes !== undefined) c.intBytes = t.intBytes;
  if ("enumValues" in t) c.enumValues = (t as { enumValues: string[] }).enumValues;
  return c;
}

const lines: string[] = [];
const counts = new Map<string, number>();
const allTables: { base: string; tmpl: (typeof TEMPLATES)[number] }[] = TEMPLATES.flatMap((tmpl) => tmpl.tables.map((base) => ({ base, tmpl })));
for (let n = 0; n < TABLES; n++) {
  dialect = pick(["postgres", "postgres", "mysql", "mysql", "sqlserver", "sqlite", "prisma", "prisma", "django"] as const);
  const convention = dialect === "prisma" ? pick([1, 1, 0]) : dialect === "sqlserver" ? pick([2, 2, 0, 3]) : pick([0, 0, 0, 0, 1, 2, 3, 4]);
  const { base, tmpl } = pick(allTables);
  const tname = tableName(base, convention === 4 ? 0 : convention);
  const labels: MeaningId[] = [];
  const cols: ColumnModel[] = [];
  const seen = new Set<string>();
  const add = (c: ColumnModel, m: MeaningId) => {
    if (seen.has(c.name.toLowerCase())) return;
    seen.add(c.name.toLowerCase());
    cols.push(c);
    labels.push(m);
  };
  // Primary key.
  const pkStyle = rand();
  const idName = style(pick(["id", "id", "id", `${base.replace(/s$/, "")}_id`, `${tableAbbrev(base)}_id`]), base, "id", convention);
  if (pkStyle < 0.55) add(column(idName, integer(pick([4, 8])), { primaryKey: true, autoIncrement: chance(0.8), nullable: false }), "id");
  else if (pkStyle < 0.8) add(column(idName, uuid(), { primaryKey: true, nullable: false, defaultValue: chance(0.5) ? pick(["gen_random_uuid()", "uuid_generate_v4()", "newid()"]) : undefined }), "uuid");
  else if (pkStyle < 0.9) add(column(idName, pick([text(25), text(30), text(21)]), { primaryKey: true, nullable: false, defaultValue: chance(0.5) ? pick(["cuid()", "nanoid()"]) : undefined }), "id");
  else add(column(idName, char(36), { primaryKey: true, nullable: false }), "uuid");
  // Foreign keys and undeclared references to other tables.
  const fks: TableModel["foreignKeys"] = [];
  for (let k = 0, nfk = int(0, 3); k < nfk; k++) {
    const other = pick(allTables).base.replace(/s$/, "");
    const name = style(`${other}_id`, base, "reference", convention);
    if (chance(0.7)) {
      add(column(name, chance(0.7) ? integer(8) : uuid(), { nullable: chance(0.3) }), "reference");
      fks.push({ columns: [name], refTable: other, refColumns: ["id"] });
    } else {
      const t = pick([integer(8), integer(4), uuid(), char(36), text(36)]);
      add(column(name, t), t.type === "uuid" || t.maxLength === 36 ? "uuid" : t.type === "integer" ? "integer" : "code");
    }
  }
  for (const slot of tmpl.slots) {
    if (!chance(slot.p ?? 1)) continue;
    const t = slot.type();
    const name = style(pick(slot.names), base, slot.m, convention);
    const unique = ["email", "username", "slug", "sku", "token", "code"].includes(slot.m) && chance(0.4);
    // A boolean stored as an integer or char(1) is still a boolean.
    add(column(name, t, { unique }), slot.m);
  }
  if (cols.length < 3) continue;
  const table = normalizeTable({ name: tname, columns: cols, primaryKey: [cols[0]!.name], foreignKeys: fks, uniques: [], checks: [] });
  const plan = infer({ dialect: dialect === "prisma" || dialect === "django" ? "postgres" : dialect, tables: [table], source: "synth" });
  table.columns.forEach((c, i) => {
    const r = plan.columns[i]!;
    const label = labels[i]!;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    lines.push(JSON.stringify({ source: "synth", split: "train", table: tname, column: c.name, type: c.type, raw_type: c.rawType, fk: label === "reference", text: columnText(table, c), label, rule: r.meaning, rule_confidence: r.confidence }));
  });
}
writeFileSync(join(import.meta.dirname, "..", "data", "synth.jsonl"), lines.join("\n") + "\n");
const agree = lines.filter((l) => {
  const o = JSON.parse(l);
  return o.label === o.rule;
}).length;
console.log(`${lines.length} synthetic columns in ${TABLES} tables; rule engine agrees with ${((agree / lines.length) * 100).toFixed(1)}%`);
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));
