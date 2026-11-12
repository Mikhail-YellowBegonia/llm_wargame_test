# Stage 2 Domain Staging: RTS Simulation Core (`docs/staging/rts-core/`)

This directory holds intermediate mechanic design notes, Eugen-style (*Wargame / WARNO / Regiments*) formula drafts, and combat tuning logs during **Stage 2 (`stage:2-rts-core`)**.

## Lifecycle Rules
1. Keep notes focused on `src/sim/` mechanics (spotting/stealth, cover & road mobility, range tiers, 4-tier morale/suppression, indirect fire HE/smoke).
2. When a mechanic is implemented in `src/sim/`, reflect its final as-built behavior in `docs/architecture.md` and prune obsolete drafts here before Stage 4 merge.
