# 0004 — Engine park compiler invocation

Experience owns `content/harbor-lights/` (layout source, categorical PNGs, explicit queue
masks, places, notices, presets). Engine owns compilation, reachability and flow-field
validation. `scripts/compile-content.mjs` currently invokes:

```
(cd engine && npm run -s compile:park -- --source ../experience/content/harbor-lights --stage 1|2)
```

and reports NOT RUN when `engine/` is absent. A should confirm or rename the script and its
inputs (PNG path `generated/stage{n}/grid.png`, `generated/stage{n}/queue-zones.json`,
`places.json`, `park.json`). Experience's validator intentionally does not replace Engine's.
