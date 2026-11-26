"""Build eval/heldout.csv: the hand-labelled held-out columns.

    cd training && uv run python ../eval/build_heldout.py

Every non-foreign-key column of the eval sources (see training/sources.json) was reviewed
against eval/LABELING.md. LABELS lists each column whose correct meaning differs from the
rule engine's proposal; every other column was checked and the rule engine's meaning kept.
`agrees_with_rule` in the CSV shows which is which, for review.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "training" / "data" / "public.jsonl"

# (source, table, column) -> label, where it differs from the rule engine.
LABELS: dict[tuple[str, str, str], str] = {
    # Chinook
    ("chinook", "employee", "title"): "job_title",
    ("chinook", "track", "composer"): "full_name",
    # Sakila
    ("sakila", "film", "rental_rate"): "money",
    ("sakila", "customer", "active"): "boolean",
    ("sakila", "payment", "payment_date"): "datetime",
    ("sakila", "rental", "rental_date"): "datetime",
    ("sakila", "rental", "return_date"): "datetime",
    # Umami
    ("umami", "api_key", "key_hash"): "token",
    ("umami", "api_key", "key_prefix"): "code",
    ("umami", "session", "browser"): "status",
    ("umami", "session", "os"): "status",
    ("umami", "session", "device"): "status",
    ("umami", "session", "screen"): "status",
    ("umami", "session", "country"): "country_code",
    ("umami", "session", "distinct_id"): "code",
    ("umami", "session_link", "distinct_id"): "code",
    ("umami", "session_data", "distinct_id"): "code",
    ("umami", "website_event", "url_query"): "text",
    ("umami", "website_event", "utm_medium"): "status",
    ("umami", "website_event", "utm_campaign"): "title",
    ("umami", "website_event", "utm_content"): "text",
    ("umami", "website_event", "gclid"): "token",
    ("umami", "website_event", "fbclid"): "token",
    ("umami", "website_event", "msclkid"): "token",
    ("umami", "website_event", "ttclid"): "token",
    ("umami", "website_event", "li_fat_id"): "token",
    ("umami", "website_event", "twclid"): "token",
    ("umami", "website_event", "event_name"): "status",
    ("umami", "website_event", "tag"): "status",
    ("umami", "event_data", "data_key"): "status",
    ("umami", "session_data", "data_key"): "status",
    ("umami", "event_data", "number_value"): "number",
    ("umami", "session_data", "number_value"): "number",
    ("umami", "revenue", "event_name"): "status",
    ("umami", "two_factor_otp_used", "otp"): "code",
    ("umami", "app_setting", "key"): "code",
    ("umami", "error_issue", "fingerprint"): "token",
    ("umami", "error_event", "release"): "code",
    ("umami", "error_event", "environment"): "status",
    ("umami", "error_event", "browser"): "status",
    ("umami", "error_event", "os"): "status",
    ("umami", "error_event", "device"): "status",
    # Healthchecks
    ("healthchecks", "accounts_profile", "next_report_date"): "datetime",
    ("healthchecks", "accounts_profile", "next_nag_date"): "datetime",
    ("healthchecks", "accounts_profile", "last_sms_date"): "datetime",
    ("healthchecks", "accounts_profile", "sms_sent"): "count",
    ("healthchecks", "accounts_profile", "last_call_date"): "datetime",
    ("healthchecks", "accounts_profile", "calls_sent"): "count",
    ("healthchecks", "accounts_profile", "sort"): "status",
    ("healthchecks", "accounts_profile", "deletion_notice_date"): "datetime",
    ("healthchecks", "accounts_profile", "over_limit_date"): "datetime",
    ("healthchecks", "accounts_profile", "last_active_date"): "datetime",
    ("healthchecks", "accounts_profile", "theme"): "status",
    ("healthchecks", "accounts_profile", "totp"): "token",
    ("healthchecks", "accounts_project", "name"): "title",
    ("healthchecks", "accounts_project", "api_key"): "token",
    ("healthchecks", "accounts_project", "api_key_readonly"): "token",
    ("healthchecks", "accounts_project", "badge_key"): "token",
    ("healthchecks", "accounts_project", "ping_key"): "token",
    ("healthchecks", "accounts_member", "transfer_request_date"): "datetime",
    ("healthchecks", "accounts_credential", "name"): "title",
    ("healthchecks", "api_check", "methods"): "status",
    ("healthchecks", "api_check", "n_pings"): "count",
    ("healthchecks", "api_ping", "scheme"): "status",
    ("healthchecks", "api_ping", "exitstatus"): "integer",
    ("healthchecks", "payments_subscription", "customer_id"): "code",
    ("healthchecks", "payments_subscription", "subscription_id"): "code",
    ("healthchecks", "payments_subscription", "plan_id"): "code",
    ("healthchecks", "payments_subscription", "plan_name"): "title",
    ("healthchecks", "payments_subscription", "address_id"): "code",
    ("healthchecks", "logs_record", "name"): "code",
    # Koel
    ("koel", "agent_conversations", "id"): "uuid",
    ("koel", "agent_conversation_messages", "id"): "uuid",
    ("koel", "agent_conversation_messages", "conversation_id"): "uuid",
    ("koel", "agent_conversation_messages", "attachments"): "json",
    ("koel", "agent_conversation_messages", "tool_calls"): "json",
    ("koel", "agent_conversation_messages", "tool_results"): "json",
    ("koel", "agent_conversation_messages", "usage"): "json",
    ("koel", "agent_conversation_messages", "meta"): "json",
}


def main() -> None:
    rows = [json.loads(line) for line in DATA.read_text(encoding="utf8").splitlines() if line]
    held = [r for r in rows if r["split"] == "eval" and not r["fk"]]
    used = set()
    out = []
    for r in held:
        key = (r["source"], r["table"], r["column"])
        label = LABELS.get(key, r["rule"])
        used.add(key)
        out.append({"source": r["source"], "table": r["table"], "column": r["column"], "type": r["type"], "raw_type": r["raw_type"], "label": label, "rule": r["rule"], "agrees_with_rule": "yes" if label == r["rule"] else "no"})
    missing = set(LABELS) - used
    if missing:
        raise SystemExit(f"labels for columns that aren't in the data: {sorted(missing)}")
    with (ROOT / "heldout.csv").open("w", newline="", encoding="utf8") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)
    print(f"{len(out)} held-out columns, {sum(o['agrees_with_rule'] == 'no' for o in out)} differ from the rule engine -> eval/heldout.csv")


if __name__ == "__main__":
    main()
