# A daily Google Trends report in Make

For someone who keeps keyword research in Google Sheets. Apify's
[official Make integration](https://docs.apify.com/integrations/make) can start
Actor runs and read Datasets. This page is a configuration guide, not an
exported blueprint: module names and options can differ between Make versions.

Use two scenarios, so a slow run never depends on a synchronous Make timeout.

## Scenario 1: start the run

**Schedule -> Apify: Run an Actor**

- Connect Apify, choose `automa-flow/google-trends-monitor` and paste
  [keyword-watchlist.json](../examples/keyword-watchlist.json) as the input.
- Use 512 MB memory, a 300-second timeout and a $0.05 spending cap where the
  module offers these options. Turn waiting for the run to finish off.
- Keep one stable `monitorId` in the input.
- Schedule it daily, for example at 07:00 UTC, only after one manual run worked.

If the module does not expose memory, timeout or the spending cap, use Apify's
API call module with
`POST /v2/acts/automa-flow~google-trends-monitor/runs?memory=512&timeout=300&maxTotalChargeUsd=0.05`
and the same JSON body. Never put the token in a URL.

## Scenario 2: read the result

**Apify: Watch Actor Runs -> filter -> Apify: Get Dataset Items -> router**

1. Filter for this Actor and status SUCCEEDED.
2. Read all pages of the run's default Dataset, not only the first bundle.
3. Read the `RUN_SUMMARY` record from the run's default key-value store. If it
   is missing, send the run to an operations sheet instead of the report.
4. Compare the number of rows you collected with the Dataset's `itemCount`
   before writing anything.
5. Route rows:
   - `record_type = observation`, `status = SUCCESS` and `change_type = BREAKOUT_NEW`
     go to a Breakouts sheet;
   - other new rising queries (`RISING_QUERY_NEW`, `RISING_QUERY_CHANGED`) go to a research sheet;
   - `group_status` rows and any `PARTIAL` or `FAILED` rows go to a status sheet;
   - `BASELINE` rows from the first run are not alerts.

## Writing to Google Sheets

Use `source_id + fingerprint + scraped_at` as the event key. Look it up in a
Make Data Store before adding a row, and record delivery only after the write
succeeds. Use RAW input if the module offers it, so a query that starts with
`=` is not treated as a formula. Keep failed checks in their own sheet so they
never replace good research data.

Before activating either scenario, test one small manual run, the error route,
a replay of the same run and a quiet run with no new signals.
