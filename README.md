# Wargame (working title)

Experimental tactical RTS where you command through an LLM chain of command.
You (Steel 6) radio an LLM company commander (Alpha 6), who radios state-machine platoons.

## M0: terminal prototype

```bash
npm install
cp .env.example .env      # put your DEEPSEEK_API_KEY in it
npm run play              # play by radio in the terminal
npm run headless          # no LLM: all platoons rush Kessel (combat tuning)
npm run typecheck
```

Agent turns are logged to `logs/session-*.jsonl` (prompt, tool calls, token usage).

## Layout

| Path | Role |
|---|---|
| `src/sim/` | Simulation core: map/LOS, units, platoon FSM, combat, scenario. No I/O. |
| `src/comms/` | Radio nets (one speaker at a time, airtime-based delay) |
| `src/perception/` | What a commander is allowed to know, as text |
| `src/agents/` | LLM commander (Vercel AI SDK + DeepSeek, tool calling) |
| `src/game.ts` | Wires everything together; UI-agnostic |
| `src/cli.ts` | Terminal UI |
