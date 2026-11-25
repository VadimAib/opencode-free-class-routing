// Offline check of the routing logic: fake host, no model calls.
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Decisions are appended to a log file under the home directory; keep this run
// out of the real one. `say()` resolves the path on every call, so setting these
// before any handler runs is enough.
const home = join(tmpdir(), `oc-free-class-route-${process.pid}`)
rmSync(home, { recursive: true, force: true })
process.env.USERPROFILE = home
process.env.HOME = home

import plugin, * as api from "../index.ts"

const LOG = join(home, ".local", "share", "opencode", "free-class-routing.log")

function logLines() {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter((line) => line.includes("free-class-routing:"))
  } catch {
    return []
  }
}

const mark = () => logLines().length
const since = (at) => logLines().slice(at)

const FREE = ["opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"]
const PAID = { providerID: "acme", id: "paid-model-1" }
const OTHER = { providerID: "acme", id: "paid-model-2" }

const catalog = [
  ...FREE.map((ref) => {
    const [providerID, ...rest] = ref.split("/")
    return { providerID, id: rest.join("/"), cost: [{ input: 0 }], capabilities: { tools: true } }
  }),
  { ...PAID, id: PAID.id, cost: [{ input: 1 }], capabilities: { tools: true } },
  { ...OTHER, cost: [{ input: 1 }], capabilities: { tools: true } },
]

function host(sessions, options) {
  // Each case stands for a fresh process: the routing markers are process-wide.
  globalThis.__subagentRoutingSeen = new Set()
  globalThis.__freeClassRetrySeen = new Set()
  globalThis.__freeClassExhausted = new Map()
  const switches = []
  const updates = []
  const retry = {}
  let push
  const queue = []
  const ctx = {
    options,
    model: { list: async () => ({ data: catalog }) },
    agent: { list: async () => [
      { id: "explore", mode: "subagent" },
      { id: "general", mode: "subagent" },
      { id: "build", mode: "primary" },
    ] },
    session: {
      get: async ({ sessionID }) => sessions[sessionID],
      switchModel: async ({ sessionID, model }) => {
        switches.push([sessionID, `${model.providerID}/${model.id}`])
        sessions[sessionID] = { ...sessions[sessionID], model }
      },
      update: async ({ sessionID, title, metadata }) => {
        updates.push({ sessionID, title, metadata })
        sessions[sessionID] = { ...sessions[sessionID], title, metadata }
      },
      hook: async (name, fn) => {
        retry[name] = fn
      },
    },
    event: {
      subscribe: (opts) => {
        push = (event) => queue.push(event)
        return (async function* () {
          for (;;) {
            while (queue.length === 0) await new Promise((r) => setTimeout(r, 5))
            yield queue.shift()
          }
        })()
      },
    },
  }
  return { ctx, switches, updates, retry, push: (e) => push(e) }
}

async function tick(cond, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout: ${label}`)
}

const base = (extra) => ({
  root: { id: "root", agent: "build", model: PAID },
  ...extra,
})

// 1. FREE class moves to the first free model.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await tick(() => h.switches.length === 1, "free switch")
  const [id, model] = h.switches[0]
  if (id !== "child" || model !== FREE[0]) throw new Error(`case 1: ${id} ${model}`)
  console.log("1 ok free ->", model)
}

// 2. TRUSTED class keeps the parent model.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "general", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "general" } })
  await new Promise((r) => setTimeout(r, 120))
  if (h.switches.length !== 0) throw new Error(`case 2 switched: ${JSON.stringify(h.switches)}`)
  console.log("2 ok trusted kept")
}

// 3. TRUSTED class on another paid model returns to the parent model.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "general", model: OTHER },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "general" } })
  await tick(() => h.switches.length === 1, "trusted to parent")
  if (h.switches[0][1] !== "acme/paid-model-1") throw new Error(`case 3: ${h.switches[0][1]}`)
  console.log("3 ok trusted -> parent")
}

// 4. A free parent model is never overridden.
{
  const sessions = base({
    root: { id: "root", agent: "build", model: { providerID: "opencode", id: "mimo-v2.6-flash-free" } },
    child: { id: "child", parentID: "root", agent: "explore", model: { providerID: "opencode", id: "mimo-v2.6-flash-free" } },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await new Promise((r) => setTimeout(r, 120))
  if (h.switches.length !== 0) throw new Error(`case 4 switched: ${JSON.stringify(h.switches)}`)
  console.log("4 ok free parent untouched")
}

// 5. No freeAgents option: every subagent is free (old behaviour).
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "general", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "general" } })
  await tick(() => h.switches.length === 1, "default free")
  if (h.switches[0][1] !== FREE[0]) throw new Error(`case 5: ${h.switches[0][1]}`)
  console.log("5 ok default -> free")
}

// 6. A malformed freeAgents value fails closed.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: "explore" })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await new Promise((r) => setTimeout(r, 120))
  if (h.switches.length !== 0) throw new Error(`case 6 switched: ${JSON.stringify(h.switches)}`)
  console.log("6 ok malformed -> trusted")
}

// 7. A free model that hits its cap moves to the next free model.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" } },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  const event = {
    sessionID: "child",
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    error: { status: 429, message: "free usage limit reached" },
  }
  await h.retry.retry(event)
  if (event.decision?.retry !== true) throw new Error("case 7: no retry decision")
  if (h.switches[0][1] !== FREE[1]) throw new Error(`case 7: ${JSON.stringify(h.switches)}`)
  console.log("7 ok free cap ->", h.switches[0][1])
}

// 8. A trusted model that hits its cap never falls back to free.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "general", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  const event = { sessionID: "child", model: PAID, error: { status: 429, message: "quota exceeded" } }
  await h.retry.retry(event)
  if (event.decision) throw new Error("case 8: retry was requested")
  if (h.switches.length !== 0) throw new Error(`case 8: ${JSON.stringify(h.switches)}`)
  console.log("8 ok trusted cap -> refused, no switch")
}

// 9. When every free model is used up, a FREE child returns to the trusted model.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" } },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  const first = { sessionID: "child", model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" }, error: { status: 429, message: "free usage limit reached" } }
  await h.retry.retry(first)
  const second = { sessionID: "child", model: { providerID: "opencode", id: "mimo-v2.6-flash-free" }, error: { status: 429, message: "free usage limit reached" } }
  await h.retry.retry(second)
  if (second.decision?.retry !== true) throw new Error("case 9: no retry decision")
  if (h.switches.at(-1)[1] !== "acme/paid-model-1") throw new Error(`case 9: ${JSON.stringify(h.switches)}`)
  const last = h.updates.at(-1)
  if (last?.title !== "Child session · free") throw new Error(`case 9 title: ${last?.title}`)
  if (last?.metadata?.model !== "acme/paid-model-1") throw new Error(`case 9 metadata: ${JSON.stringify(last?.metadata)}`)
  console.log("9 ok free chain exhausted -> parent")
}

// 10. A TRUSTED child that sits on a free model returns to the parent model.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "general", model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" } },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  const event = { sessionID: "child", model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" }, error: { status: 429, message: "free usage limit reached" } }
  await h.retry.retry(event)
  if (event.decision?.retry !== true) throw new Error("case 10: no retry decision")
  if (h.switches.at(-1)[1] !== "acme/paid-model-1") throw new Error(`case 10: ${JSON.stringify(h.switches)}`)
  console.log("10 ok trusted on free model -> parent")
}

// 11. A cap reported inside error.data is still a cap.
{
  const verdict = api.classify({ status: 429, data: { type: "provider.free-limit", message: "usage limit reached" } })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 11: ${JSON.stringify(verdict)}`)
  console.log("11 ok nested cap detected")
}

// 12. A price the catalog does not report is not a zero price.
{
  if (api.isAutoFree({ providerID: "opencode", id: "x", cost: { input: 0 } })) throw new Error("case 12: object cost treated as free")
  if (!api.isAutoFree({ providerID: "opencode", id: "y", cost: [{ input: 0 }] })) throw new Error("case 12: zero price not free")
  console.log("12 ok unknown price is not free")
}

// 13. A wrapper error type must not hide a cap inside data.
{
  const verdict = api.classify({
    type: "provider.error",
    message: "Provider request failed",
    data: { type: "provider.quota", message: "free usage limit reached" },
  })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 13: ${JSON.stringify(verdict)}`)
  console.log("13 ok nested cap behind a wrapper type")
}

// 14. A null tier is not a zero price.
{
  if (api.isAutoFree({ providerID: "opencode", id: "z", cost: [null] })) throw new Error("case 14: null tier treated as free")
  console.log("14 ok null tier is not free")
}

// 15. A tier without a reported price is not a zero price.
{
  if (api.isAutoFree({ providerID: "opencode", id: "w", cost: [{}] })) throw new Error("case 15: empty tier treated as free")
  console.log("15 ok tier without a price is not free")
}

// 16. A cap two wrappers deep is still a cap.
{
  const verdict = api.classify({ type: "provider.error", cause: { cause: { type: "provider.quota", message: "quota exceeded" } } })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 16: ${JSON.stringify(verdict)}`)
  console.log("16 ok cap two wrappers deep")
}

// 17. A cap under an `error` key is a cap.
{
  const verdict = api.classify({
    type: "provider.error",
    error: { type: "provider.free-limit", message: "free usage limit reached" },
  })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 17: ${JSON.stringify(verdict)}`)
  console.log("17 ok cap under error")
}

// 18. A cap in a response body is a cap.
{
  const verdict = api.classify({ type: "provider.error", body: { type: "provider.quota", message: "quota exceeded" } })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 18: ${JSON.stringify(verdict)}`)
  console.log("18 ok cap in body")
}

// 19. A cap inside an array is a cap.
{
  const verdict = api.classify({
    type: "provider.error",
    data: { errors: [{ message: "daily token limit reached" }] },
  })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 19: ${JSON.stringify(verdict)}`)
  console.log("19 ok cap inside an array")
}

// 20. A reason is the fragment that names the cap, never the whole sentence.
{
  const why = api.capReason({
    type: "provider.error",
    message: "Provider request failed",
    data: { message: "free usage limit reached" },
  })
  if (why !== "free usage limit") throw new Error(`case 20: ${why}`)
  console.log("20 ok reason from the cap node")
}

// 21. A cap type without a message is the reason when nothing else names it.
{
  const why = api.capReason({ type: "provider.error", message: "Provider request failed", data: { type: "provider.quota" } })
  if (why !== "provider.quota") throw new Error(`case 21: ${why}`)
  console.log("21 ok reason from the cap type")
}

// 22. A cyclic payload terminates and is still read.
{
  const loop = { type: "provider.quota", message: "quota exceeded" }
  loop.data = loop
  const started = Date.now()
  const verdict = api.classify(loop)
  if (!verdict.hard) throw new Error(`case 22: ${JSON.stringify(verdict)}`)
  if (Date.now() - started > 1000) throw new Error(`case 22: took ${Date.now() - started}ms`)
  console.log("22 ok cyclic payload")
}

// 23. A price written as a string is not a zero price.
{
  if (api.isAutoFree({ providerID: "opencode", id: "v", cost: [{ input: "0" }] })) throw new Error("case 23: string price treated as free")
  console.log("23 ok string price is not free")
}

// 24. The usual axios shape nests the cap below response.data.error.
{
  const verdict = api.classify({
    response: { status: 429, data: { error: { message: "daily token limit reached" } } },
  })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 24: ${JSON.stringify(verdict)}`)
  console.log("24 ok cap at response.data.error")
}

// 25. A status on one element of a sibling list does not outrank the cap text.
{
  const verdict = api.classify({ message: "quota exceeded", data: { errors: [{ status: 503 }] } })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 25: ${JSON.stringify(verdict)}`)
  console.log("25 ok cap text outranks a nested status")
}

// 26. A long list under one key does not hide a cap under a later one.
{
  const noise = Array.from({ length: 250 }, (_, i) => ({ message: `noise ${i}` }))
  const verdict = api.classify({
    type: "provider.error",
    data: { errors: noise },
    error: { type: "provider.quota", message: "quota exceeded" },
  })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 26: ${JSON.stringify(verdict)}`)
  console.log("26 ok long array does not starve the cap")
}

// 27. A throttle-worded wrapper does not outrank the inner cap wording.
{
  const why = api.capReason({ status: 429, message: "429 Too Many Requests", data: { message: "free usage limit reached" } })
  if (why !== "free usage limit") throw new Error(`case 27: ${why}`)
  console.log("27 ok hard wording beats a throttle wrapper")
}

// 28. A cap no pattern covers is still quoted, so the log keeps a cause.
{
  const why = api.capReason({ status: 402, message: "Insufficient balance" })
  if (why !== "Insufficient balance") throw new Error(`case 28: ${why}`)
  console.log("28 ok uncovered cap wording quoted")
}

// 29. Only the matched fragment reaches the log, not the sentence around it.
{
  const why = api.capReason({ status: 402, body: { errors: [{ message: "quota exceeded for api key sk-test-0000000000" }] } })
  if (why !== "quota exceeded") throw new Error(`case 29: ${why}`)
  console.log("29 ok reason is the matched fragment")
}

// 30. Only structural evidence may park a free model for the day.
{
  const echoed = api.classify({ status: 400, message: "invalid model id: 'daily token limit reached' is not supported" })
  if (!echoed.hard || echoed.structural) throw new Error(`case 30 echoed: ${JSON.stringify(echoed)}`)
  const real = api.classify({ status: 429, message: "free usage limit reached" })
  if (!real.structural) throw new Error(`case 30 real: ${JSON.stringify(real)}`)
  const typed = api.classify({ type: "provider.free-limit", message: "whatever" })
  if (!typed.structural) throw new Error(`case 30 typed: ${JSON.stringify(typed)}`)
  const bare = api.classify({ message: "daily token limit reached" })
  if (!bare.structural) throw new Error(`case 30 bare: ${JSON.stringify(bare)}`)
  console.log("30 ok text alone does not park a free model")
}

// 31. A key-shaped token never reaches the log; ordinary text is left alone.
{
  const redacted = api.clean("upstream rejected Authorization Bearer sk-test-0000000000, contact billing@corp.example")
  if (redacted.includes("sk-test-0000000000")) throw new Error(`case 31: ${redacted}`)
  if (!redacted.includes("billing@corp.example")) throw new Error(`case 31 too much: ${redacted}`)
  if (api.clean("free usage limit reached") !== "free usage limit reached") throw new Error("case 31: ordinary text changed")
  console.log("31 ok key-shaped token redacted")
}

// 32. A cap in the second array of the tree is still read.
{
  const noise = Array.from({ length: 60 }, (_, i) => ({ message: `noise ${i}` }))
  const verdict = api.classify({
    data: { errors: noise },
    error: { errors: [{ message: "quota exceeded" }] },
  })
  if (!verdict.quota || !verdict.hard) throw new Error(`case 32: ${JSON.stringify(verdict)}`)
  console.log("32 ok sibling array read")
}

// 33. An OpenCode without session.hook/switchModel: setup resolves and leaves
//     exactly one line naming the reason, instead of throwing.
{
  const sessions = base({})
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  delete h.ctx.session.hook
  delete h.ctx.session.switchModel
  const at = mark()
  await plugin.setup(h.ctx)
  const lines = since(at)
  if (lines.length !== 1) throw new Error(`case 33: ${lines.length} lines\n${lines.join("\n")}`)
  if (!lines[0].includes("idle, this OpenCode has no session hooks (incompatible plugin API)")) {
    throw new Error(`case 33: ${lines[0]}`)
  }
  if (h.switches.length !== 0) throw new Error(`case 33 switched: ${JSON.stringify(h.switches)}`)
  console.log("33 ok no session hooks -> one line, idle")
}

// 34. An OpenCode without model.list: same contract.
{
  const sessions = base({})
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  h.ctx.model = {}
  const at = mark()
  await plugin.setup(h.ctx)
  const lines = since(at)
  if (lines.length !== 1) throw new Error(`case 34: ${lines.length} lines\n${lines.join("\n")}`)
  if (!lines[0].includes("idle, this OpenCode has no model.list (incompatible plugin API)")) {
    throw new Error(`case 34: ${lines[0]}`)
  }
  if (h.switches.length !== 0) throw new Error(`case 34 switched: ${JSON.stringify(h.switches)}`)
  console.log("34 ok no model.list -> one line, idle")
}

// 35. An OpenCode without an event stream: setup still resolves and says the
//     subagents keep their model.
{
  const sessions = base({})
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  delete h.ctx.event
  const at = mark()
  await plugin.setup(h.ctx)
  const lines = since(at)
  if (lines.length !== 1) throw new Error(`case 35: ${lines.length} lines\n${lines.join("\n")}`)
  if (!lines[0].includes("no event stream; subagents keep their model")) throw new Error(`case 35: ${lines[0]}`)
  if (h.switches.length !== 0) throw new Error(`case 35 switched: ${JSON.stringify(h.switches)}`)
  console.log("35 ok no event stream -> one line, idle")
}

// 36. The decision reaches the child itself: its title carries class and model,
//     its metadata carries the same facts for an API reader.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", title: "Ревью SET-3: correctness", metadata: { host: "tag" }, model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await tick(() => h.switches.length === 1 && h.updates.length === 1, "label")
  const update = h.updates[0]
  if (update.sessionID !== "child") throw new Error(`case 36: ${JSON.stringify(update)}`)
  if (update.title !== "Ревью SET-3: correctness · free:deepseek-v4.1-flash-free") throw new Error(`case 36 title: ${update.title}`)
  const expected = { host: "tag", class: "free", model: FREE[0], parent: "acme/paid-model-1" }
  if (JSON.stringify(update.metadata) !== JSON.stringify(expected)) throw new Error(`case 36 metadata: ${JSON.stringify(update.metadata)}`)
  console.log("36 ok title, metadata and existing keys")
}

// 37. The label is idempotent: a duplicated event writes once, and a fresh
//     process (the routing marker is gone) does not grow the title.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", title: "Ревью SET-3: correctness", model: PAID },
  })
  const options = { freeModels: FREE, freeAgents: ["explore"] }
  const h = host(sessions, options)
  await plugin.setup(h.ctx)
  const event = { data: { sessionID: "child", parentID: "root", agent: "explore" } }
  h.push(event)
  h.push(event)
  await tick(() => h.switches.length === 1 && h.updates.length === 1, "one label")
  await new Promise((r) => setTimeout(r, 120))
  if (h.updates.length !== 1) throw new Error(`case 37: ${h.updates.length} labels in one process`)
  const labelled = sessions.child.title
  if (labelled !== "Ревью SET-3: correctness · free:deepseek-v4.1-flash-free") throw new Error(`case 37 title: ${labelled}`)

  const again = host(sessions, options)
  // The host dropped the metadata; the title still carries the old suffix.
  delete sessions.child.metadata
  await plugin.setup(again.ctx)
  again.push(event)
  await tick(() => again.switches.length === 1, "reload route")
  await new Promise((r) => setTimeout(r, 50))
  if (again.updates.length !== 1) throw new Error(`case 37: ${again.updates.length} labels after a reload`)
  for (const update of again.updates) {
    const separators = update.title.match(/ · /g)?.length ?? 0
    if (separators !== 1 || !update.title.startsWith("Ревью SET-3: correctness · ")) {
      throw new Error(`case 37 grew: ${update.title}`)
    }
  }
  console.log("37 ok duplicate event and reload keep one suffix")
}

// 38. An unavailable session API costs one line; the child is still routed.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", title: "Ревью SET-3: correctness", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  h.ctx.session.update = async () => {
    throw new Error("api down")
  }
  const at = mark()
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await tick(() => h.switches.length === 1 && since(at).length === 2, "label failure")
  const lines = since(at)
  if (!lines.some((line) => line.includes("could not label subagent child (api down); routing continues"))) {
    throw new Error(`case 38: ${lines.join("\n")}`)
  }
  if (!lines.some((line) => line.includes(`agent=explore class=free model=${FREE[0]}`))) {
    throw new Error(`case 38 decision missing: ${lines.join("\n")}`)
  }
  console.log("38 ok label failure keeps the route")
}

// 39. A session API that accepts the write and never answers costs one line
//     after the label timeout; the child is still routed.
{
  const sessions = base({
    child: { id: "child", parentID: "root", agent: "explore", title: "Ревью SET-3: correctness", model: PAID },
  })
  const h = host(sessions, { freeModels: FREE, freeAgents: ["explore"] })
  h.ctx.session.update = () => new Promise(() => {})
  const at = mark()
  await plugin.setup(h.ctx)
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await tick(() => h.switches.length === 1 && since(at).length === 2, "label timeout", 300)
  const lines = since(at)
  if (!lines.some((line) => line.includes("could not label subagent child (timeout); routing continues"))) {
    throw new Error(`case 39: ${lines.join("\n")}`)
  }
  if (!lines.some((line) => line.includes(`agent=explore class=free model=${FREE[0]}`))) {
    throw new Error(`case 39 decision missing: ${lines.join("\n")}`)
  }
  console.log("39 ok hung label times out, route continues")
}

// 40. Label edge cases: empty and host fallback titles, an offset timestamp,
//     a free class on a paid model, and repeated suffixes.
{
  const free = { providerID: "opencode", id: "free-1" }
  const paid = { providerID: "acme", id: "paid-model-1" }
  const cases = [
    [undefined, "free", free, true, "Child session · free:free-1"],
    ["", "trusted", paid, false, "Child session · trusted"],
    ["New session - 2026-11-25T10:00:00Z", "trusted", paid, false, "Child session · trusted"],
    ["Child session - 2026-11-25T10:00:00.123+03:00", "free", free, true, "Child session · free:free-1"],
    ["X", "free", paid, false, "X · free"],
    ["X · free:a · free:b", "trusted", paid, false, "X · trusted"],
  ]
  for (const [title, cls, model, isFree, expected] of cases) {
    const actual = api.routeLabel(title, cls, model, isFree)
    if (actual !== expected) throw new Error(`case 40: ${JSON.stringify({ title, cls, expected, actual })}`)
  }
  console.log("40 ok label edge cases")
}

console.log("all offline cases passed")
process.exit(0)
