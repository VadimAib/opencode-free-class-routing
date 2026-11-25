# opencode-free-class-routing

OpenCode routes a subagent to a free model only when the agent that runs it is
listed in `freeAgents`. Every other child keeps the model of the root session,
which is never changed.

Free models are fine for work a machine checks afterwards: a search, a quoted
fact, a test run. They are not fine for reviews, plans, security work or anything
that writes.

## Install (no npm)

No package manager, no build step: OpenCode loads `index.ts` directly.

1. Put this folder anywhere, for example `C:/tools/opencode-free-class-routing`.
2. Add it to `~/.config/opencode/opencode.json` (or a project config):

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-free-class-routing",
      "options": {
        "freeAgents": ["explore"],
        "freeModels": [
          "opencode/deepseek-v4.1-flash-free",
          "opencode/mimo-v2.6-flash-free",
          "opencode/iceman-free"
        ]
      }
    }
  ]
}
```

3. Save the config; OpenCode reloads plugins without a restart.

## Options

- `freeAgents` — the agents whose subagents may run on a free model; every other
  agent is trusted. Absent means every subagent is free. A value that is not an
  array means no agent is free, so a typo cannot send trusted work to a free
  model.
- `freeModels` — the free chain, tried in order. Without it, every enabled
  `opencode` or `opencode-go` model with a reported input price of zero is free;
  a price the catalog does not report is not free.

## Behaviour

- FREE agent: the next free model in the chain. When all of them are used up, the
  child returns to the root session's model.
- TRUSTED agent: the root session's model. On a cap the turn fails; there is no
  fallback to a free model.
- A free model that reports a daily or free-tier cap is skipped for the rest of
  the local day; a short `429` or `5xx` goes back to OpenCode's own retry.
- If the root session itself runs on a free model, that choice wins.
- The class comes from `session.agent`, never from the text of the prompt.

## Visible decision

The child carries the router's decision itself, so nobody has to open the log:

- Its title gets one suffix: ` · trusted`, or ` · free:<model-id>` for example
  `Ревью SET-3: correctness · free:deepseek-v4.1-flash-free`. A free-class child
  that had to keep a paid model is labelled ` · free`, so the title never calls a
  paid model free; its metadata names the model actually used.
- Its metadata gets the machine-readable form:
  `{ "class": "free", "model": "opencode/deepseek-v4.1-flash-free", "parent": "acme/paid-model-1" }`.

The suffix is replaced, not appended, so a duplicate event or a plugin reload
cannot grow the title. The root session is never touched. This writes a title and
metadata, but no message: no prompt and no synthetic input. A host that refuses
the update, or an OpenCode too old to have `session.update`, keeps routing: the
failure is one log line and the child keeps its model. A measured free child kept
its labelled title after its first real prompt.

The parent chat shows a subagent card with the agent name and the task
description, not the child's title. The label is visible in the child's own header
and in the session list; open the child from that card to see it.

## Logs

One line per decision on stderr, and the same line in
`~/.local/share/opencode/free-class-routing.log` (the desktop app discards
stderr):

```text
free-class-routing: agent=explore class=free model=opencode/deepseek-v4.1-flash-free parent=acme/paid-model-1 reason=subagent started; free class, free model
free-class-routing: agent=general class=trusted model=acme/paid-model-1 parent=acme/paid-model-1 reason=subagent started; trusted class, parent model kept
```

The reason is the fragment of the provider's message that names the cap, not the
whole sentence.

## Testing

Node 24 runs both suites directly, with no build step and no dependencies:

```sh
node test/route.test.mjs   # 40 cases, offline, no model calls
node test/e2e.test.mjs     # 11 cases: setup, session.created, the retry hook, two loaded copies, stop(), the log file, the title/metadata label
```

There is no `package.json` on purpose: OpenCode loads `index.ts` by path, so a
manifest would add nothing to install or to run.

## Limits

- Only child sessions are routed; the root session is never changed.
- A child whose agent has `mode: primary`, and a fork, are left alone.
- OpenCode may load the plugin more than once per process; a child is routed once.
- Tested against OpenCode `2.2.5` and the desktop app `2.4.1` on 2026-11-24. It
  uses the session event stream and the `retry` hook; if a future version removes
  either, it logs one line and stays out of the way.

## License

MIT. Based on `opencode-fallback-model` by vimtor (MIT); see [LICENSE](LICENSE).
