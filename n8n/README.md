# Google Trends keyword watchlist in n8n

[keyword-watchlist.json](keyword-watchlist.json) runs the Actor with the
[keyword watchlist input](../examples/keyword-watchlist.json), checks that the
run is complete and returns one item with new signals, baselines, group
statuses and problems kept apart. It is inactive, starts manually and contains
no credentials.

## Set it up

1. Install the official [Apify node for n8n](https://docs.apify.com/integrations/n8n)
   (`@apify/n8n-nodes-apify`). The workflow uses Code node v2 and HTTP Request v4.2.
2. Import `keyword-watchlist.json`.
3. In **Run Actor**, select an **Apify API** credential. Review the JSON input,
   the $0.05 spending cap, 512 MB memory, 300-second timeout and the `latest` build.
4. In the three **Read** nodes, select an **HTTP Header Auth** credential with
   name `Authorization` and value `Bearer YOUR_APIFY_TOKEN`, from the same account.
   Keep the token only in n8n credentials.
5. Run it once manually and inspect the **Useful output** item.

## What the workflow checks

- **Require completed run** stops unless the run SUCCEEDED and belongs to this Actor.
- **Read summary** fetches `RUN_SUMMARY`; a missing summary means completeness is unknown.
- **Validate size** reads the Dataset item count and stops above 10,000 rows.
  For bigger runs use the [Python](../python/trends_run.py) or
  [Node.js](../node/run.mjs) script, which page through everything.
- **Useful output** stops if the rows read differ from the item count, then returns:

| Field | Use it for |
| --- | --- |
| `events` | New rising queries, new Breakouts, changed growth bands, new Trending Now topics |
| `baseline` | What the first run recorded; not an alert |
| `groupStatus` | One row per keyword group |
| `problems` | `PARTIAL` or `FAILED` rows; route them to whoever maintains the workflow |
| `summary`, `rows` | The run summary and every row, for audit |

## Send new signals somewhere

Connect your own nodes after **Useful output**. For Slack, split `events`,
keep `change_type = BREAKOUT_NEW` if you only want Breakouts, and include the
related query, country, `source_url` and `scraped_at`. Before sending, store
`source_id + fingerprint + scraped_at` as the event key so a replay does not
notify twice. Send `problems` to a separate operational channel. Never let the
problem branch overwrite good records.

## Schedule it

After a successful manual run, replace **Manual start** with a Schedule
Trigger, for example daily at 07:00 UTC, and keep the same input and
`monitorId`. The Actor stores the monitoring baseline, not the workflow. The
first run records a baseline and returns no events; that is expected.

If a Read node fails after the run has started, take the run ID from the
execution and read it with `--resume` in the Python or Node.js script. Do not
start **Run Actor** again blindly: that is a second paid run.
