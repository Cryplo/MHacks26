# 0006 — Location-scoped event query for heatmap drill-down

Heatmap "supporting events" currently page through `getEvents` (up to 10,000 events) and
filter by position within 3 m client-side. An additive `getEvents` filter
`{ near: Vec2, radiusM, fromMs, toMs }` (or cell index) would keep this exact for long runs.
