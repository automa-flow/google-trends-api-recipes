"""Offline tests. They never call Apify or Google."""

import csv
import json
from pathlib import Path

import pytest
import trends_run as tr

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "fixtures" / "sample_output.json").read_text(encoding="utf-8"))


class FakeApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append((method, url))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        status, payload = response
        return status, json.dumps(payload).encode() if payload is not None else b""


def make_api(responses):
    fake = FakeApi(responses)
    return tr.Apify("test-token", fetch=fake, sleep=lambda seconds: None), fake


def test_run_start_is_never_retried():
    api, fake = make_api([(503, {"error": "busy"})])
    with pytest.raises(tr.ApiError):
        api.start_run({"keywords": ["meal prep"]}, build="latest", memory=512, timeout=300, max_charge=0.05)
    assert len(fake.calls) == 1


def test_lost_start_response_is_not_retried():
    api, fake = make_api([TimeoutError("response lost")])
    with pytest.raises(TimeoutError):
        api.start_run({"keywords": ["meal prep"]}, build="latest", memory=512, timeout=300, max_charge=0.05)
    assert len(fake.calls) == 1


def test_start_sends_the_spending_cap():
    api, fake = make_api([(201, {"data": {"id": "run1"}})])
    run_id = api.start_run({"keywords": ["x"]}, build="latest", memory=512, timeout=300, max_charge=0.05)
    assert run_id == "run1"
    method, url = fake.calls[0]
    assert method == "POST" and "maxTotalChargeUsd=0.05" in url and tr.ACTOR in url


def test_reads_are_retried_after_a_temporary_error():
    api, fake = make_api([(503, None), OSError("reset"), (200, {"data": {"status": "SUCCEEDED"}})])
    assert api.get("/actor-runs/run1")["data"]["status"] == "SUCCEEDED"
    assert len(fake.calls) == 3


def test_all_dataset_pages_are_read():
    first = [{"n": i} for i in range(tr.PAGE_SIZE)]
    api, fake = make_api([(200, first), (200, [{"n": "last"}]), (200, [])])
    rows = api.read_items("dataset1")
    assert len(rows) == tr.PAGE_SIZE + 1
    assert "offset=1000" in fake.calls[1][1]


def run_record(**overrides):
    run = {
        "id": "run1",
        "actId": tr.ACTOR_ID,
        "status": "SUCCEEDED",
        "defaultKeyValueStoreId": "store1",
        "defaultDatasetId": "dataset1",
    }
    return {**run, **overrides}


def test_collect_keeps_failed_rows_and_requires_a_summary():
    rows = [{"status": "FAILED", "record_type": "group_status"}, {"status": "SUCCESS"}]
    api, _ = make_api([(200, {"isFinal": True}), (200, rows), (200, [])])
    assert tr.collect(api, run_record())["rows"] == rows

    api, _ = make_api([(404, {"error": "not found"})])
    with pytest.raises(ValueError, match="RUN_SUMMARY"):
        tr.collect(api, run_record())


def test_collect_refuses_unfinished_or_foreign_runs():
    api, _ = make_api([])
    with pytest.raises(ValueError, match="different Actor"):
        tr.collect(api, run_record(actId="other"))
    with pytest.raises(ValueError, match="TIMED-OUT"):
        tr.collect(api, run_record(status="TIMED-OUT"))


def test_sample_output_is_split_without_hiding_problems():
    parts = tr.split_rows(FIXTURE)
    assert {row["change_type"] for row in parts["events"]} == {"BREAKOUT_NEW", "RISING_QUERY_CHANGED"}
    assert [row["change_type"] for row in parts["baseline"]] == ["BASELINE"]
    assert len(parts["groupStatus"]) == 2
    assert [row["status"] for row in parts["problems"]] == ["PARTIAL"]
    assert all(row["status"] == "SUCCESS" for row in parts["events"] + parts["measurements"])


def test_not_found_is_not_a_problem():
    parts = tr.split_rows([{"record_type": "group_status", "status": "NOT_FOUND"}])
    assert parts["problems"] == [] and len(parts["groupStatus"]) == 1


def test_timeline_csv_keeps_partial_flag(tmp_path):
    path = tmp_path / "timeline.csv"
    assert tr.write_timeline_csv(path, FIXTURE) == 2
    with path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["keyword"] == "chatgpt"
    assert [row["is_partial"] for row in rows] == ["False", "True"]


def test_cost_estimate_counts_groups_and_feeds():
    estimate = tr.estimate_max_cost(
        {
            "keywords": ["a", "b"],
            "queries": [{"keywords": ["c", "d"]}],
            "dataTypes": ["interest_over_time", "trending_now"],
            "trendingGeos": ["US", "GB"],
        }
    )
    assert estimate == {"keywordGroups": 3, "trendingFeeds": 2, "maxEventCostUsd": 0.016}
    assert tr.estimate_max_cost({"dataTypes": ["trending_now"], "geo": "DE"})["keywordGroups"] == 0


@pytest.mark.parametrize("name", sorted(p.name for p in (ROOT / "examples").glob("*.json")))
def test_examples_preview_without_a_token(name, capsys, monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    assert tr.main([str(ROOT / "examples" / name)]) == 0
    preview = json.loads(capsys.readouterr().out)
    assert preview["estimate"]["maxEventCostUsd"] <= preview["maxChargeUsd"]


def test_env_file_is_parsed_without_printing_it(tmp_path):
    env = tmp_path / ".env"
    env.write_text('# comment\nAPIFY_TOKEN="secret"\nOTHER=1\n', encoding="utf-8")
    assert tr.read_env_file(env)["APIFY_TOKEN"] == "secret"
