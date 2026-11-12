# Wargame (working title)

Experimental tactical RTS where you command through an LLM chain of command.
You (Steel 6) radio an LLM company commander (Alpha 6), who radios state-machine platoons.

## Quick Start

- **Web Demo (GitHub Pages)**: <https://mikhail-yellowbegonia.github.io/llm_wargame_test/> (paste your DeepSeek API key in the top bar; stored only in your browser's `localStorage`).
- **Manual Deploy**: `gh workflow run deploy.yml --ref main` (or trigger *Deploy to GitHub Pages* in the GitHub Actions tab for any branch).

```bash
npm install
cp .env.example .env      # put your DEEPSEEK_API_KEY in it
npm run dev               # play on the browser staff map (http://localhost:5173)
npm run play              # or play by radio in the terminal
npm run headless          # no LLM: deterministic combat runner
npm run typecheck
```

## Documentation & Roadmap

- [`AGENTS.md`](AGENTS.md) — Contributor & coding-agent rules, **4-stage development roadmap (`stage:1` to `stage:4`)**, and GitHub Issue contract.
- [`docs/architecture.md`](docs/architecture.md) — As-built architecture, module boundaries, and player information model.
- [`docs/ai-survey.md`](docs/ai-survey.md) — Literature survey & Stage 3 design principles for LLM tactical command.

## Layout

| Path | Role |
|---|---|
| `src/sim/` | Simulation core: map/LOS, units, platoon FSM, combat, scenario. No I/O. |
| `src/comms/` | Radio nets (one speaker at a time, airtime-based delay) |
| `src/perception/` | What a commander is allowed to know, as text |
| `src/agents/` | LLM commander (Vercel AI SDK + DeepSeek, tool calling) |
| `src/game.ts` | Wires everything together; UI-agnostic |
| `src/cli.ts` | Terminal UI |
