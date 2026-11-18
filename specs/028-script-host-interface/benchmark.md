# Feature 028 benchmark — cz-host vs. expectations (T019)

Measured on the dev box (Fedora, Python 3.14.10, R embedded, Release build)
via `tests/conformance/` driver: spawn → ready line → first run → 30 warm
runs of a trivial script. Times in ms.

| module  | host startup (spawn→ready) | first call | warm p50 | warm p95 |
|---------|---------------------------|-----------|----------|----------|
| python  | 29                        | 3.8       | 3.4      | 3.9      |
| r       | 95                        | 45.3      | 4.2      | 5.0      |

Notes:
- Host startup amortizes across the session — subsequent runs pay only
  NDJSON + in-process dispatch (single-digit ms), far below the
  subprocess runner's per-call interpreter spawn (~50–200 ms for python,
  more for Rscript).
- First-call is warm-interpreter dispatch only; interpreter init happens
  at cz_open inside the startup window.
- FR-023's "auto = benchmark winner" is satisfied trivially: the host
  wins whenever its runtime probe is usable.
