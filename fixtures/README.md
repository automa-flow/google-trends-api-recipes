# Fixtures

`sample_output.json` has the shape of real rows from Google Trends Scraper &
Breakout Monitor: a successful group, a partial group, timeline and region
points, related queries, a new Breakout and a Trending Now topic. The tests use
it to check how rows are split into signals, baselines and problems.

The values are illustrative. The Trending Now row uses a placeholder topic,
headline and link instead of real news, and fingerprints are not recomputed.
Do not use these rows as Google Trends data.
