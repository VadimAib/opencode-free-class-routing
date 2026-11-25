# opencode-free-class-routing

OpenCode sends a subagent to a free model only when its work can be checked by
a machine afterwards. Reviews, plans, security work and anything that writes
stay on the model the human chose for the chat.

The main session is never changed.

## Why

Free models are fine for a search, a quoted fact or a test run: the result is
checked before it is used. They are not fine for work whose output is accepted
as is. In practice, review subagents on a free model produced reports describing
work that did not happen, carried context from another task, and disagreed with
the numbers in the repository; one started editing files instead of reviewing.

Routing by class fixes that without giving up the free chain for cheap work.

## Classes

| Class | Work | Model |
| --- | --- | --- |
| FREE | a search, a fact with its source, a test or guard run, fixtures, JSON by template, a one-liner with examples, a rename in one file, a log summary, "which pages are about this" | free chain, in the order of `freeModels` |
| TRUSTED | review and audit, plans and architecture, risk, security and permissions, anything that writes to the repo, config or database, long multi-step work, acceptance | the model of the root session |

The class comes from the agent that runs the child (`session.agent`), never from
the text of the prompt. The trusted model is the model of the root session, read
when the child starts; the plugin never guesses it by model name.

## Install (no npm)

No package manager, no build step. OpenCode loads `index.ts` directly.

1. Put this folder anywhere, for example `C:/tools/opencode-free-class-routing`.
2. Add it to `~/.config/opencode/opencode.json` (or a project config):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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

On Windows use forward slashes: `"package": "C:/tools/opencode-free-class-routing"`.

3. Save the config. OpenCode reloads plugins; no restart is needed.

## Options

- `freeAgents` — the agents whose subagent sessions may run on a free model.
  Every other agent is trusted. Absent means every subagent is free, which was
  the behaviour of earlier versions. A value that is not an array means
  no agent is free, so a typo cannot send trusted work to a free model.
- `freeModels` — the free chain, tried in order. Without it, every enabled
  `opencode` or `opencode-go` model with a reported input price of zero is free.
  A model whose price the catalog does not report is not free.

## What happens on a limit

- FREE class: the next free model in the chain; when all of them are used up,
  the child returns to the trusted model.
- TRUSTED class: the child stays on the trusted model. When its limit is hit the
  turn fails; there is no fallback to a free model.
- A free model that reports a daily, free-tier or account cap is remembered for
  the rest of the local day.
- A short `429` or a `5xx` is left to OpenCode's own retry.

## A free model chosen by the human

If the root session itself runs on a free model, the human's choice wins: the
plugin does not move the child to anything else, neither the free chain nor a
paid model.

## Logs

One line per decision on stderr: agent, class, chosen model, parent model, reason.
The desktop app starts the server with a stderr nobody reads, so each line is
also appended to `~/.local/share/opencode/free-class-routing.log`.

```text
free-class-routing: agent=explore class=free model=opencode/deepseek-v4.1-flash-free parent=acme/paid-model-1 reason=subagent started; free class, free model
free-class-routing: agent=general class=trusted model=acme/paid-model-1 parent=acme/paid-model-1 reason=subagent started; trusted class, parent model kept
free-class-routing: agent=explore class=free model=opencode/mimo-v2.6-flash-free parent=acme/paid-model-1 reason=opencode/deepseek-v4.1-flash-free failed (free usage limit); free class, free model
free-class-routing: agent=general class=trusted model=acme/paid-model-1 parent=acme/paid-model-1 reason=acme/paid-model-1 failed (quota exceeded); trusted class, parent model kept
```

The reason is the fragment of the provider's message that names the cap, not the
whole sentence: an error body can echo the request, and the log is a file.

## Limits

- Only child sessions (subagents) are routed. A root session is never changed.
- A child whose agent has `mode: primary` and a fork are left alone.
- OpenCode may load a global plugin more than once per process. A child is
  routed once at creation, so one decision is not applied several times.
- The class is a list of agent names. An agent that does one kind of work both
  ways belongs in whichever class is cheaper to be wrong about.

Tested against OpenCode `2.2.5` (the API names) and the desktop app `2.4.1` on
2026-11-24 with live subagents. Uses the session event stream and the `retry`
hook; if a future OpenCode removes either, the plugin logs one line and stays
out of the way.

## License

MIT. Based on `opencode-fallback-model` by vimtor (MIT); see [LICENSE](LICENSE).
