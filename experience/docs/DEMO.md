# Three-minute demo (adapts to measured outcomes)

Run this on the **live profile against A's engine and B's mock worker** (or real Jev when
authorized). Fixture data is for rehearsing clicks only and is never a substitute for the
evidence below. Keep a saved real run and a screen recording as backups, both labeled
**Recorded**.

| Time | Show | Say (only what the screen shows) |
|---|---|---|
| 0:00–0:30 | Live run of Harbor Lights at 300 guests, Activity colouring, health strip. | "Each dot is one synthetic guest; groups move together but keep individual needs. The clock only advances when every required decision is back — that is what *Waiting on N decisions* means." |
| 0:30–1:10 | Guests tab → pick a family near the churro cart → Inspector. | Read the observed notice text and version, the options in prompt order, the **highest probability** vs **sampled** tags, draw *u*, and the source badge (Mock or Jev). "A group decision governs the children; they didn't sample separately." |
| 1:10–1:40 | Compare A/B page for the **price-only** experiment (pass $15 → $25, all else fixed). | Read status, pairs complete/requested, every pair's B−A in original units, and the label (Illustrative/Exploratory/Mock). Say what the numbers are, including neutral or negative ones. Min/max are spread, not confidence bounds. |
| 1:40–2:20 | Hand the judge an **operator** link (explicit warning) on their phone; they type "close the coaster at 2pm" in What-if. | Show the draft (park time, place, scope), confirm, receipt with scheduled time, then **applied** from Engine evidence. Both screens show the same revision. |
| 2:20–2:50 | Results → heatmap (waiting person-minutes) → top location → supporting events → inspect. | "Contributions are assigned by the model, not proven real-world causes." |
| 2:50–3:00 | Limitations block / printable summary. | "Synthetic guests, not calibrated to real people; this is a way to test decisions before trying them, not a forecast." |

Do **not** show the separated-child/bump story (feature not implemented). Do not pick a
different seed because a result looks unfavourable.

## Recording procedure

1. Live profile, Chromium at 1440×900, DPR 2; close other tabs.
2. Start the screen recorder; begin at the live page with the run already warmed up from a
   real checkpoint (the health strip discloses the checkpoint) or at opening.
3. Follow the table above; keep the mode badge in frame.
4. Export the run JSON from Results and archive it with the video; title the video
   "Recorded — <run id> — <date>".
5. Recorded replays in the app (`/runs/:id/replay`) display the **Recorded** badge and frame
   resolution; they never call Jev.

## Rehearsal on fixtures

`npm run dev` → fixture operator → New run → Start at 60x → follow the same clicks. The
fixture's scripted guests do not react to what-ifs and its numbers are not outcomes.
