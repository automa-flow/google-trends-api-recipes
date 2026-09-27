# Migrating from pytrends

pytrends is archived and its last commit is from August 2024. If your code
still calls it, this page shows the equivalent input for
[Google Trends Scraper & Breakout Monitor](https://apify.com/automa-flow/google-trends-monitor)
and how to get a DataFrame shaped like the one you had.

Google has also announced an official Trends API, available to a limited
group of testers. If you have access to it, compare it first.

## The main differences

- **No session setup.** There is no `TrendReq`, no cookies and no `hl`/`tz`.
  Timestamps come back in UTC, ISO-8601.
- **Many payloads per run.** pytrends handles one `build_payload` at a time.
  One run here takes up to 200 keyword groups, each with its own location,
  window, category or property if you need them.
- **Rate limits are handled for you.** Instead of `TooManyRequestsError`, the
  Actor rotates proxy sessions and retries within a bounded budget. A group
  that still fails is reported as `FAILED` with an error code such as
  `THROTTLED`, and it is not charged.
- **Rows, not DataFrames.** Each result is a JSON row with the keyword, date,
  value and status. The snippet below turns it back into a wide table.
- **It is a paid hosted service**: $0.004 per completed keyword group, proxy
  included. See [Cost](README.md#cost).

## Method by method

| pytrends | Input for this Actor | Notes |
| --- | --- | --- |
| `build_payload(kw_list, cat, timeframe, geo, gprop)` | `"queries": [{"keywords": kw_list}]`, `category`, `timeframe`, `geo`, `property` | Up to 5 keywords per group. `gprop` values map to `property`: `""` is `web`, `froogle` is `shopping`; `images`, `news` and `youtube` keep their names |
| `interest_over_time()` | `"dataTypes": ["interest_over_time"]` | Rows with `data_type = interest_over_time`; `is_partial` replaces the `isPartial` column |
| `interest_by_region()` | `"dataTypes": ["interest_by_region"]` | Regions below the chosen location, for example US states for `US`. There is no `resolution` switch for cities or metro areas |
| `related_queries()` | `"dataTypes": ["related_queries"]` | Top and rising in one list, `related_type` tells them apart; Breakouts have `formatted_value = "Breakout"` |
| `related_topics()` | Not available | Google currently answers that endpoint with an empty list |
| `trending_searches(pn=...)`, `realtime_trending_searches(pn=...)` | `"dataTypes": ["trending_now"], "trendingGeos": ["US"]` | Uses country codes; `trend_volume` is Google's approximate traffic, with news titles and links |
| `get_historical_interest()` | `timeframe`: `now 1-H`, `now 4-H`, `now 1-d`, `now 7-d` or `"2025-11-01 2026-01-31"` | Google chooses hourly, daily, weekly or monthly buckets from the window |
| `multirange_interest_over_time()` | Several groups in `queries`, each with its own `timeframe` | Values from different windows are not comparable |
| `suggestions()`, `top_charts()` | Not available | |

## From pytrends code to a run

pytrends:

```python
from pytrends.request import TrendReq

pytrends = TrendReq(hl="en-US", tz=360)
pytrends.build_payload(["python", "javascript", "rust"], timeframe="today 12-m", geo="US")
df = pytrends.interest_over_time()
```

Here, the same request is [examples/compare-keywords.json](examples/compare-keywords.json):

```json
{
  "queries": [{"keywords": ["python", "javascript", "rust"], "externalId": "languages"}],
  "geo": "US",
  "timeframe": "today 12-m",
  "dataTypes": ["interest_over_time", "interest_by_region"],
  "mode": "snapshot",
  "outputMode": "all"
}
```

Run it and write the timeline as CSV:

```sh
python python/trends_run.py examples/compare-keywords.json --execute --timeline-csv timeline.csv
```

Then rebuild the wide DataFrame that `interest_over_time()` returned:

```python
import pandas as pd

rows = pd.read_csv("timeline.csv", parse_dates=["timestamp"])
group = rows[rows["comparison_group"] == rows["comparison_group"].iloc[0]]  # one group at a time
df = group.pivot_table(index="timestamp", columns="keyword", values="value")
df["isPartial"] = group.groupby("timestamp")["is_partial"].max()
```

Pivot one comparison group at a time. Keywords from different groups were
scaled separately by Google, so putting them in one table would suggest a
comparison the data does not support.

## Check before you trust a table

pytrends raised an exception or returned an empty DataFrame when Google
refused a request. Here, a refused check becomes a row with `status` set to
`PARTIAL` or `FAILED` and an `error` object. `NOT_FOUND` means Google answered
and had no data. The Python and Node.js scripts count these separately; read
[Read the results safely](README.md#read-the-results-safely) before replacing
a pytrends job in production.
