// Split Actor rows into new signals, baselines, measurements, group statuses and problems.
// NOT_FOUND is a verified empty answer. PARTIAL and FAILED mean the check did not finish
// and must never be read as "no data".

export const CHANGE_TYPES = new Set(['BREAKOUT_NEW', 'RISING_QUERY_NEW', 'RISING_QUERY_CHANGED', 'TRENDING_TOPIC_NEW']);
const PROBLEM_STATUSES = new Set(['PARTIAL', 'FAILED']);

export function splitRows(rows) {
  const parts = { events: [], baseline: [], measurements: [], groupStatus: [], problems: [] };
  for (const row of rows) {
    if (PROBLEM_STATUSES.has(row.status)) parts.problems.push(row);
    if (row.record_type === 'group_status') parts.groupStatus.push(row);
    else if (row.status !== 'SUCCESS') continue;
    else if (row.change_type === 'BASELINE') parts.baseline.push(row);
    else if (CHANGE_TYPES.has(row.change_type)) parts.events.push(row);
    else parts.measurements.push(row);
  }
  return parts;
}

// Interest over time in long format, one row per keyword and date, with the partial-day flag kept.
export function timelineRows(rows) {
  return rows
    .filter(r => r.data_type === 'interest_over_time' && r.status === 'SUCCESS' && r.has_data)
    .map(({ comparison_group, keyword, geo, timeframe, property, timestamp, value, is_partial }) =>
      ({ comparison_group, keyword, geo, timeframe, property, timestamp, value, is_partial }));
}
