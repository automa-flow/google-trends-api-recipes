# Google Trends API recipes for Python, Node.js, n8n and Make

[![tests](https://github.com/automa-flow/google-trends-api-recipes/actions/workflows/tests.yml/badge.svg)](https://github.com/automa-flow/google-trends-api-recipes/actions/workflows/tests.yml)

Need Google Trends data in a script, a spreadsheet or a scheduled job?
These small, tested examples call
[Google Trends Scraper & Breakout Monitor](https://apify.com/automa-flow/google-trends-monitor),
a hosted Actor on Apify, and save every result row with its status.

If you used pytrends: the library is archived and its last commit is from
August 2024. Its most common failure was Google's per-IP rate limit (HTTP 429).
This Actor rotates proxy sessions, retries within a bounded budget and tells
you which checks did not finish, instead of returning an empty table.
[Migrating from pytrends](MIGRATING-FROM-PYTRENDS.md) maps each pytrends call
to an input field.

## What you get

| Data | Input value | One row per |
| --- | --- | --- |
| Interest over time | `interest_over_time` | keyword and date, with `is_partial` for an unfinished last period |
| Interest by region | `interest_by_region` | keyword and region |
| Related queries | `related_queries` | top or rising query; Breakouts are flagged |
| Trending Now | `trending_now` | trending topic per country, with approximate traffic and news links |

Every run also writes a `group_status` row for each keyword group and a
`RUN_SUMMARY` record. Values are relative (0-100 within one comparison group),
not search counts.

## Quick start (Python, no dependencies)

1. Create an Apify account and copy your API token from
   **Console > Settings > API & Integrations**.
2. Preview an input. This is free and needs no token:

   ```sh
   python python/trends_run.py examples/quick-start.json
   ```

3. Start one run. It is capped at $0.05:

   ```sh
   export APIFY_TOKEN=your_token          # PowerShell: $env:APIFY_TOKEN="your_token"
   python python/trends_run.py examples/quick-start.json --execute
   ```

The script saves `runs/RUN_ID/results.json` with the run summary and all rows,
then prints how many new signals and unfinished checks it found. Add
`--timeline-csv timeline.csv` to get interest over time as a CSV. You can also
keep the token in a `.env` file and pass `--env-file .env`.

If the script stops after the run has started, do not start another one.
Continue with `--resume RUN_ID`. The start request is sent exactly once
because a lost response can still mean the run exists.

## Examples

| File | What it does | Cost if every check completes |
| --- | --- | ---: |
| [quick-start.json](examples/quick-start.json) | Related and rising searches for `meal prep` in the US | $0.004 |
| [compare-keywords.json](examples/compare-keywords.json) | `python`, `javascript` and `rust` compared over 12 months, plus US states | $0.004 |
| [keyword-watchlist.json](examples/keyword-watchlist.json) | Two product groups in monitor mode: later runs return only new rising queries and Breakouts | $0.008 |
| [trending-now.json](examples/trending-now.json) | Today's Trending Now topics in the US and UK | $0.004 |

## Cost

Pricing is per completed check, and it already includes Apify platform usage
and the residential proxy:

- **$0.004** per completed keyword group. A group is 1-5 keywords compared
  together for one location, time window, category and Google property. All
  data types you select for that group are included.
- **$0.002** per Trending Now country feed.
- Checks that fail or finish only partly are **not charged**. A group that
  Google answers with no data is charged, because the check was done.

For example, 100 keyword groups a day cost $0.40 a day. Prices are as of
27 September 2026. The Actor's
[Pricing tab](https://apify.com/automa-flow/google-trends-monitor/pricing) is
authoritative. The preview prints the upper bound for your input, and
`--max-charge` sets the run's spending cap.

## Read the results safely

A run that finished with status SUCCEEDED can still contain a keyword group
that Google refused. Check the status on each row:

| Status | Meaning |
| --- | --- |
| `SUCCESS` | Google answered and the data is complete |
| `NOT_FOUND` | Google answered and had no data for this group |
| `PARTIAL` | Some data types for the group are missing; see `error` |
| `FAILED` | The check could not be completed; this is not the same as "no data" |

The scripts split rows into new signals, first-run baselines, measurements,
group statuses and problems, so a failed check never looks like a quiet day.

Compare values only inside one comparison group. Scores from different
groups, locations, time windows or properties are scaled separately by Google.

## Schedule a watchlist

Use `"mode": "monitor"` with `"outputMode": "changesOnly"` and a stable
`monitorId`, as in [keyword-watchlist.json](examples/keyword-watchlist.json).

- The first successful run records a baseline and sends no alerts.
- Later runs return new rising queries, new Breakouts, changed growth bands and
  new Trending Now topics, plus one status row per group.
- A failed check keeps the last good baseline, so it cannot create fake changes.

Run it daily with an Apify Schedule, cron, n8n or Make. Keep the same input and
`monitorId` between runs.

## Other ways to run it

- **Node.js 18+**, no dependencies: `node node/run.mjs examples/quick-start.json --execute`
- **Bash + curl + jq**: `bash curl/run.sh examples/quick-start.json --execute`
- **n8n**: import [the keyword watchlist workflow](n8n/README.md)
- **Make**: [two-scenario setup](make/README.md) for a daily report in Google Sheets
- **AI agents**: the Actor is available through the [Apify MCP server](https://docs.apify.com/integrations/mcp)

## Limits

- Up to 5 keywords per comparison group (Google's limit) and up to 200 groups per run.
- Related topics are not offered: Google currently answers that endpoint with an empty list.
- Trending Now is per country; there is no worldwide feed.
- Google sets the time bucket (hourly, daily, weekly or monthly) from the window.
- Throughput is bounded by Google's rate limits, not by the Actor.

This project is not affiliated with Google. "Google Trends" is a trademark of
Google LLC. The Actor reads publicly available Google Trends data without a
Google login, CAPTCHA solving or a browser.

## Tests

The tests run offline against a saved sample output and never call Apify or Google.

```sh
python -m pip install pytest
python -m pytest python
cd node && node --test
```

## Support

Something wrong with a run? Open an issue on the
[Actor page](https://apify.com/automa-flow/google-trends-monitor/issues) with
the run ID, what you expected and a small input without secrets. Questions
about these examples are welcome as GitHub issues here.

Maintained by Vadim Bezrukov ([automa-flow on Apify](https://apify.com/automa-flow)).
If you need Google Trends or other web data wired into your own pipeline, you
can reach me through that profile.

## License

[MIT](LICENSE)
