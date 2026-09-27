#!/usr/bin/env bash
# Run Google Trends Scraper & Breakout Monitor with Bash, curl and jq.
#
#   bash curl/run.sh examples/quick-start.json              preview, free
#   bash curl/run.sh examples/quick-start.json --execute    one paid run, capped at $0.05
#   bash curl/run.sh --resume RUN_ID                        read an existing run
#
# Export APIFY_TOKEN in a trusted shell first. Output goes to runs/RUN_ID/.
set -euo pipefail

api='https://api.apify.com/v2'
actor='automa-flow~google-trends-monitor'
actor_id='WecREidW3gHipWFzP'
max_charge=0.05
timeout=300
memory=512

# Counts of rows, new signals and unfinished checks in a saved items.jsonl file.
summarize() {
  jq -s --arg run "$2" '{
    runId: $run,
    rows: length,
    newSignals: [.[] | select(.status == "SUCCESS" and .record_type != "group_status"
      and (.change_type | IN("BREAKOUT_NEW", "RISING_QUERY_NEW", "RISING_QUERY_CHANGED", "TRENDING_TOPIC_NEW")))] | length,
    partialOrFailedRows: [.[] | select(.status == "PARTIAL" or .status == "FAILED")] | length
  }' "$1"
}

if [[ "${1:-}" == '--summarize' ]]; then
  summarize "${2:?items.jsonl path}" "${3:-local}"
  exit 0
elif [[ "${1:-}" == '--resume' ]]; then
  run_id="${2:-}"
else
  input="${1:-examples/quick-start.json}"
  if [[ "${2:-}" != '--execute' ]]; then
    jq . "$input"
    echo 'Preview only. Add --execute to start a paid run.' >&2
    exit 0
  fi
fi

: "${APIFY_TOKEN:?Export APIFY_TOKEN first}"
auth=(-H "Authorization: Bearer $APIFY_TOKEN")

if [[ -z "${run_id:-}" ]]; then
  # One attempt only: a lost response can still mean the run exists. Check Console, then --resume.
  started=$(curl --fail-with-body -sS --max-time 90 "${auth[@]}" \
    -H 'Content-Type: application/json' --data-binary "@$input" \
    "$api/acts/$actor/runs?build=latest&memory=$memory&timeout=$timeout&maxTotalChargeUsd=$max_charge") \
    && run_id=$(jq -er .data.id <<< "$started") \
    || { echo 'Could not confirm the run start. A paid run may still have been created: check https://console.apify.com/actors/runs before trying again, then use --resume RUN_ID.' >&2; exit 2; }
  echo "Started run $run_id. If this script stops, continue with: --resume $run_id" >&2
fi
[[ "$run_id" =~ ^[A-Za-z0-9]+$ ]] || { echo '--resume expects an Apify run ID' >&2; exit 2; }

out="runs/$run_id"
mkdir -p "$out"
get() { curl --fail-with-body -sS --retry 3 --retry-delay 2 --max-time 90 "${auth[@]}" "$@"; }

for ((attempt = 0; attempt < 10; attempt++)); do
  get "$api/actor-runs/$run_id?waitForFinish=60" > "$out/run.json"
  case "$(jq -r .data.status "$out/run.json")" in
    READY|RUNNING|TIMING-OUT|ABORTING) ;;
    *) break ;;
  esac
done

status=$(jq -r .data.status "$out/run.json")
if [[ "$(jq -r .data.actId "$out/run.json")" != "$actor_id" ]]; then
  echo 'This run belongs to a different Actor' >&2
  exit 1
fi
case "$status" in
  SUCCEEDED) ;;
  READY|RUNNING|TIMING-OUT|ABORTING)
    echo "Run $run_id is still $status. Read it later with --resume $run_id" >&2
    exit 1 ;;
  *)
    echo "Run is $status. Inspect it before starting another: https://console.apify.com/view/runs/$run_id" >&2
    exit 1 ;;
esac

store=$(jq -r .data.defaultKeyValueStoreId "$out/run.json")
dataset=$(jq -r .data.defaultDatasetId "$out/run.json")
get "$api/key-value-stores/$store/records/RUN_SUMMARY" > "$out/summary.json" \
  || { echo 'RUN_SUMMARY is missing, so completeness is unknown' >&2; exit 1; }

expected=$(get "$api/datasets/$dataset" | jq -r '.data.itemCount // empty')
offset=0
: > "$out/items.jsonl"
while true; do
  get "$api/datasets/$dataset/items?offset=$offset&limit=1000" > "$out/page.json"
  count=$(jq -er 'if type == "array" then length else error("unexpected dataset page") end' "$out/page.json")
  [[ "$count" == 0 ]] && break
  jq -c '.[]' "$out/page.json" >> "$out/items.jsonl"
  offset=$((offset + count))
done
rm -f "$out/page.json"
if [[ -n "$expected" && "$offset" -lt "$expected" ]]; then
  echo "Read $offset of $expected rows, so the result is incomplete. Try --resume later" >&2
  exit 1
fi

report=$(summarize "$out/items.jsonl" "$run_id")
echo "$report"
echo "Saved: $out/items.jsonl and $out/summary.json" >&2
if [[ "$(jq .partialOrFailedRows <<< "$report")" != 0 ]]; then
  echo 'Some checks are PARTIAL or FAILED. Read their error before using that data.' >&2
fi
