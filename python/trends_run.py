"""Run Google Trends Scraper & Breakout Monitor on Apify and keep every result row.

Preview an input for free:

    python python/trends_run.py examples/quick-start.json

Start one paid run, capped by --max-charge:

    python python/trends_run.py examples/quick-start.json --execute

Read a run that already exists instead of starting another:

    python python/trends_run.py --resume RUN_ID

Only the Python standard library is used. The API token is read from the
APIFY_TOKEN environment variable or from a KEY=VALUE file passed as --env-file.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

API = "https://api.apify.com/v2"
ACTOR = "automa-flow~google-trends-monitor"
ACTOR_ID = "WecREidW3gHipWFzP"
CONSOLE_RUN_URL = "https://console.apify.com/view/runs/{run_id}"

# Event prices on 27 September 2026. The Actor's Pricing tab is authoritative.
GROUP_PRICE_USD = 0.004
TRENDING_FEED_PRICE_USD = 0.002

TERMINAL = {"SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"}
CHANGE_TYPES = {"BREAKOUT_NEW", "RISING_QUERY_NEW", "RISING_QUERY_CHANGED", "TRENDING_TOPIC_NEW"}
PROBLEM_STATUSES = {"PARTIAL", "FAILED"}
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
PAGE_SIZE = 1000

Fetch = Callable[[str, str, bytes | None, dict[str, str]], tuple[int, bytes]]


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


class SameHostAuthRedirect(urllib.request.HTTPRedirectHandler):
    """urllib forwards every header on a redirect; never send the token to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl).hostname != urllib.parse.urlsplit(req.full_url).hostname:
            new.remove_header("Authorization")
        return new


OPENER = urllib.request.build_opener(SameHostAuthRedirect)


def urllib_fetch(method: str, url: str, body: bytes | None, headers: dict[str, str]) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class Apify:
    """Minimal Apify API client. GET requests retry; the run start never does."""

    def __init__(self, token: str, fetch: Fetch = urllib_fetch, sleep: Callable[[float], None] = time.sleep):
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self._fetch = fetch
        self._sleep = sleep

    def _call(self, method: str, path: str, params: dict[str, Any] | None, body: Any, attempts: int) -> Any:
        url = f"{API}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None if body is None else json.dumps(body).encode()
        for attempt in range(1, attempts + 1):
            try:
                status, raw = self._fetch(method, url, data, self._headers)
            except OSError:
                if attempt == attempts:
                    raise
                self._sleep(2**attempt)
                continue
            if status in RETRYABLE_STATUS and attempt < attempts:
                self._sleep(2**attempt)
                continue
            if status >= 400:
                raise ApiError(status, raw[:300].decode(errors="replace"))
            return json.loads(raw) if raw else None
        raise AssertionError("unreachable")

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return self._call("GET", path, params, None, attempts=4)

    def start_run(
        self, actor_input: dict[str, Any], *, build: str, memory: int, timeout: int, max_charge: float
    ) -> str:
        # One attempt only: if the response is lost, the run may still exist. Check Console, then --resume.
        params = {"build": build, "memory": memory, "timeout": timeout, "maxTotalChargeUsd": max_charge}
        response = self._call("POST", f"/acts/{ACTOR}/runs", params, actor_input, attempts=1)
        return str(response["data"]["id"])

    def wait_for_run(self, run_id: str, deadline_seconds: int) -> dict[str, Any]:
        started = time.monotonic()
        while True:
            run = self.get(f"/actor-runs/{run_id}", {"waitForFinish": 60})["data"]
            if run["status"] in TERMINAL or time.monotonic() - started > deadline_seconds:
                return run

    def read_summary(self, store_id: str) -> dict[str, Any]:
        try:
            summary = self.get(f"/key-value-stores/{store_id}/records/RUN_SUMMARY")
        except ApiError as error:
            if error.status == 404:
                raise ValueError("RUN_SUMMARY is missing, so completeness is unknown") from error
            raise
        if not isinstance(summary, dict):
            raise TypeError("RUN_SUMMARY is not an object, so completeness is unknown")
        return summary

    def read_items(self, dataset_id: str) -> list[dict[str, Any]]:
        """Read every page, then check the count against the Dataset's own itemCount."""
        expected = self.get(f"/datasets/{dataset_id}")["data"].get("itemCount")
        rows: list[dict[str, Any]] = []
        while True:
            page = self.get(f"/datasets/{dataset_id}/items", {"offset": len(rows), "limit": PAGE_SIZE})
            if not page:
                break
            rows.extend(page)
        if isinstance(expected, int) and len(rows) < expected:
            raise ValueError(f"Read {len(rows)} of {expected} rows, so the result is incomplete. Try --resume later")
        return rows


def collect(api: Apify, run: dict[str, Any]) -> dict[str, Any]:
    """A SUCCEEDED run is necessary but not sufficient: keep the summary and every row."""
    if run.get("actId") != ACTOR_ID:
        raise ValueError("This run belongs to a different Actor")
    if run.get("status") not in TERMINAL:
        raise ValueError(
            f"Run {run.get('id')} is still {run.get('status')}. Read it later with --resume {run.get('id')}"
        )
    if run.get("status") != "SUCCEEDED":
        link = CONSOLE_RUN_URL.format(run_id=run.get("id"))
        raise ValueError(f"Run is {run.get('status')}. Inspect it before starting another: {link}")
    summary = api.read_summary(run["defaultKeyValueStoreId"])
    rows = api.read_items(run["defaultDatasetId"])
    return {"runId": run["id"], "summary": summary, "rows": rows}


def split_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Separate new signals from baselines, measurements, group statuses and source problems.

    NOT_FOUND is a verified empty answer from Google, not a problem. PARTIAL and
    FAILED mean the check could not be completed and must never read as "no data".
    """
    parts: dict[str, list[dict[str, Any]]] = {
        "events": [],
        "baseline": [],
        "measurements": [],
        "groupStatus": [],
        "problems": [],
    }
    for row in rows:
        if row.get("status") in PROBLEM_STATUSES:
            parts["problems"].append(row)
        if row.get("record_type") == "group_status":
            parts["groupStatus"].append(row)
        elif row.get("status") != "SUCCESS":
            continue
        elif row.get("change_type") == "BASELINE":
            parts["baseline"].append(row)
        elif row.get("change_type") in CHANGE_TYPES:
            parts["events"].append(row)
        else:
            parts["measurements"].append(row)
    return parts


def timeline_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Interest over time as long-format rows, one per keyword and date."""
    columns = ("comparison_group", "keyword", "geo", "timeframe", "property", "timestamp", "value", "is_partial")
    return [
        {column: row.get(column) for column in columns}
        for row in rows
        if row.get("data_type") == "interest_over_time" and row.get("status") == "SUCCESS" and row.get("has_data")
    ]


def estimate_max_cost(actor_input: dict[str, Any]) -> dict[str, Any]:
    """Upper bound if every group completes. Failed and partial groups are not charged."""
    data_types = actor_input.get("dataTypes") or ["interest_over_time", "related_queries", "interest_by_region"]
    keyword_types = [t for t in data_types if t != "trending_now"]
    groups = len(actor_input.get("keywords") or []) + len(actor_input.get("queries") or [])
    groups = groups if keyword_types else 0
    feeds = 0
    if "trending_now" in data_types:
        feeds = len(actor_input.get("trendingGeos") or [actor_input.get("geo") or "US"])
    total = round(groups * GROUP_PRICE_USD + feeds * TRENDING_FEED_PRICE_USD, 6)
    return {"keywordGroups": groups, "trendingFeeds": feeds, "maxEventCostUsd": total}


def read_env_file(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip().removeprefix("export ").strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def write_timeline_csv(path: Path, rows: list[dict[str, Any]]) -> int:
    table = timeline_rows(rows)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "comparison_group",
                "keyword",
                "geo",
                "timeframe",
                "property",
                "timestamp",
                "value",
                "is_partial",
            ],
        )
        writer.writeheader()
        writer.writerows(table)
    return len(table)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", nargs="?", type=Path, default=Path("examples/quick-start.json"))
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--execute", action="store_true", help="start one paid run")
    action.add_argument("--resume", metavar="RUN_ID", help="read an existing run instead of starting one")
    parser.add_argument("--max-charge", type=float, default=0.05, help="spending cap in USD (default 0.05)")
    parser.add_argument("--timeout", type=int, default=300, help="run timeout in seconds (default 300)")
    parser.add_argument("--memory", type=int, default=512, help="run memory in MB (default 512)")
    parser.add_argument("--build", default="latest", help="Actor build tag or number (default latest)")
    parser.add_argument("--env-file", type=Path, help="read APIFY_TOKEN from a KEY=VALUE file")
    parser.add_argument("--out-dir", type=Path, default=Path("runs"), help="where to save results (default runs/)")
    parser.add_argument("--timeline-csv", type=Path, help="also write interest over time as CSV")
    args = parser.parse_args(argv)

    if args.resume and not re.fullmatch(r"[A-Za-z0-9]+", args.resume):
        parser.error("--resume expects an Apify run ID")

    actor_input: dict[str, Any] = {}
    if not args.resume:
        actor_input = json.loads(args.input.read_text(encoding="utf-8"))
        estimate = estimate_max_cost(actor_input)
        if not args.execute:
            print(json.dumps({"input": actor_input, "estimate": estimate, "maxChargeUsd": args.max_charge}, indent=2))
            print("Preview only. Add --execute to start a paid run.", file=sys.stderr)
            return 0
        if estimate["maxEventCostUsd"] > args.max_charge:
            print(
                f"Note: completing every group would cost ${estimate['maxEventCostUsd']}, above --max-charge "
                f"${args.max_charge}. The run will stop charging at the cap and report the remaining groups.",
                file=sys.stderr,
            )

    env = read_env_file(args.env_file) if args.env_file else {}
    token = env.get("APIFY_TOKEN") or os.environ.get("APIFY_TOKEN")
    if not token:
        parser.error("set APIFY_TOKEN or pass --env-file")
    api = Apify(token)

    if args.resume:
        run_id = args.resume
    else:
        try:
            run_id = api.start_run(
                actor_input, build=args.build, memory=args.memory, timeout=args.timeout, max_charge=args.max_charge
            )
        except (ApiError, OSError) as error:
            print(
                f"Could not confirm the run start ({error}). A paid run may still have been created: check "
                "https://console.apify.com/actors/runs before trying again, then use --resume RUN_ID.",
                file=sys.stderr,
            )
            return 2
        print(f"Started run {run_id}. If this script stops, continue with: --resume {run_id}", file=sys.stderr)

    try:
        run = api.wait_for_run(run_id, deadline_seconds=args.timeout + 120)
        result = collect(api, run)
    except (ValueError, TypeError, ApiError) as error:
        print(error, file=sys.stderr)
        return 1
    parts = split_rows(result["rows"])

    out = args.out_dir / run_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    report = {
        "runId": run_id,
        "rows": len(result["rows"]),
        "newSignals": len(parts["events"]),
        "baselineRows": len(parts["baseline"]),
        "groups": len(parts["groupStatus"]),
        "partialOrFailedRows": len(parts["problems"]),
        "saved": str(out / "results.json"),
    }
    if args.timeline_csv:
        report["timelineRows"] = write_timeline_csv(args.timeline_csv, result["rows"])
    print(json.dumps(report, indent=2))
    if parts["problems"]:
        print("Some checks are PARTIAL or FAILED. Read their error before using that data.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
