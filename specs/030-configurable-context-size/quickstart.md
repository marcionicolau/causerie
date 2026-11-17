# Quickstart — validation

Synthetic documents only (generate with any script producing repeated sentences; ~12,000 tokens ≈ 9,000 words).

| ID | Scenario | Pass |
|---|---|---|
| Q1 | Default settings, load a model, check the model view | effective size 4096 (SC-002) |
| Q2 | Set 16384, click "Reload now", send a ~12,000-token document + question | full answer (SC-001) |
| Q3 | Set 1,000,000 on a model trained for 32768 | effective 32768, clamp notice (FR-004) |
| Q4 | Set a size above the advisor recommendation | warning with the recommendation; proceed allowed (FR-007) |
| Q5 | Choose a size too large for free memory, load | falls back to 4096 with a message; model works (FR-008, SC-004) |
| Q6 | Per-model override vs global default, fusion with two models | each model uses its own size (US3) |
| Q7 | Save a chat context at 4096, change to 8192, reload, continue | old snapshot discarded, answer correct (SC-005) |
| Q8 | Send one message larger than the size in effect | pre-send warning with needed size; raise or send anyway (FR-013) |
| Q9 | Export then import settings | context block round-trips (D8) |
Commands: `bun run typecheck`, `bun run lint`, `bun test ./tests`.
