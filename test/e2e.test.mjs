// End-to-end check: the plugin loaded, a session created, a retry, and the log
// line the live check in AGENTS.md reads. Fake host, no model calls.
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// `say()` resolves the log path from the home directory on every call; set this
// before setup runs so the real log stays untouched.
const home = join(tmpdir(), `oc-free-class-e2e-${process.pid}`)
rmSync(home, { recursive: true, force: true })
process.env.USERPROFILE = home
process.env.HOME = home

const LOG = join(home, ".local", "share", "opencode", "free-class-routing.log")
const { default: plugin } = await import("../index.ts")

const FREE = ["opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"]
const PAID = "acme/paid-model-1"
const ref = (value) => {
  const [providerID, ...rest] = value.split("/")
  return { providerID, id: rest.join("/") }
}

const catalog = [
  ...FREE.map((value) => ({ ...ref(value), cost: [{ input: 0 }], capabilities: { tools: true } })),
  { ...ref(PAID), cost: [{ input: 1 }], capabilities: { tools: true } },
]

function host(sessions, options) {
  // Each case stands for a fresh process: the routing markers are process-wide.
  globalThis.__subagentRoutingSeen = new Set()
  globalThis.__freeClassRetrySeen = new Set()
  globalThis.__freeClassExhausted = new Map()
  const switches = []
  const retry = {}
  let push
  const queue = []
  const ctx = {
    options,
    model: { list: async () => ({ data: catalog }) },
    agent: {
      list: async () => [
        { id: "explore", mode: "subagent" },
        { id: "general", mode: "subagent" },
        { id: "build", mode: "primary" },
      ],
    },
    session: {
      get: async ({ sessionID }) => sessions[sessionID],
      switchModel: async ({ sessionID, model }) => {
        switches.push(`${sessionID} ${model.providerID}/${model.id}`)
        sessions[sessionID] = { ...sessions[sessionID], model }
      },
      hook: async (name, fn) => {
        retry[name] = fn
      },
    },
    event: {
      subscribe: (opts = {}) => {
        const { signal } = opts
        push = (event) => queue.push(event)
        return (async function* () {
          for (;;) {
            if (signal?.aborted) return
            if (queue.length === 0) {
              await new Promise((r) => setTimeout(r, 5))
              continue
            }
            yield queue.shift()
          }
        })()
      },
    },
  }
  return { ctx, switches, retry, push: (event) => push(event), pending: () => queue.length }
}

async function tick(cond, label) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout: ${label}`)
}

const settle = () => new Promise((r) => setTimeout(r, 30))

function logLines() {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter((line) => line.includes("free-class-routing:"))
  } catch {
    return []
  }
}

const mark = () => logLines().length
const since = (at) => logLines().slice(at)

function expectLine(lines, needle, label) {
  const line = lines.find((entry) => entry.includes(needle))
  if (!line) throw new Error(`${label}: no log line with "${needle}"\n${lines.join("\n")}`)
  return line
}

const sessions = () => ({
  root: { id: "root", agent: "build", model: ref(PAID) },
  child: { id: "child", parentID: "root", agent: "explore", model: ref(PAID) },
})

// 1. An explore child is switched to the first free model and logged once.
{
  const s = sessions()
  const h = host(s, { freeModels: FREE, freeAgents: ["explore"] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  // The host may deliver the same created event twice; one decision is enough.
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  h.push({ data: { sessionID: "child", parentID: "root", agent: "explore" } })
  await tick(() => h.switches.length === 1, "explore switch")
  await tick(() => h.pending() === 0, "queue drained")
  await settle()
  if (h.switches.length !== 1) throw new Error(`case 1: routed ${h.switches.length} times`)
  if (h.switches[0] !== `child ${FREE[0]}`) throw new Error(`case 1: ${h.switches[0]}`)
  const lines = since(at)
  if (lines.length !== 1) throw new Error(`case 1: ${lines.length} decision lines\n${lines.join("\n")}`)
  const line = expectLine(lines, `agent=explore class=free model=${FREE[0]} parent=${PAID}`, "case 1")
  if (!line.includes("reason=subagent started; free class, free model")) throw new Error(`case 1 reason: ${line}`)
  stop()
  console.log("1 ok explore -> free, one log line")
}

// 2. A general child keeps the parent's paid model and is logged as trusted.
{
  const s = sessions()
  s.child = { ...s.child, agent: "general" }
  const h = host(s, { freeModels: FREE, freeAgents: ["explore"] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  h.push({ data: { sessionID: "child", parentID: "root", agent: "general" } })
  await tick(() => since(at).length === 1, "general decision")
  const line = expectLine(since(at), `agent=general class=trusted model=${PAID} parent=${PAID}`, "case 2")
  if (!line.includes("reason=subagent started; trusted class, parent model kept")) throw new Error(`case 2 reason: ${line}`)
  if (h.switches.length !== 0) throw new Error(`case 2 switched: ${h.switches.join(", ")}`)
  stop()
  console.log("2 ok general kept the parent model")
}

// 3. A cap behind a wrapper moves a free child to the next free model, and the
//    reason is the fragment that names the cap, not the wrapper's sentence.
{
  const s = sessions()
  s.child = { ...s.child, model: ref(FREE[0]) }
  const h = host(s, { freeModels: FREE, freeAgents: ["explore"] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  const event = {
    sessionID: "child",
    model: ref(FREE[0]),
    error: {
      type: "provider.error",
      message: "Provider request failed",
      data: { type: "provider.free-limit", message: "free usage limit reached" },
    },
  }
  await h.retry.retry(event)
  if (event.decision?.retry !== true) throw new Error("case 3: no retry decision")
  if (h.switches[0] !== `child ${FREE[1]}`) throw new Error(`case 3: ${h.switches[0]}`)
  const line = expectLine(since(at), `model=${FREE[1]}`, "case 3")
  if (!line.includes(`reason=${FREE[0]} failed (free usage limit)`)) throw new Error(`case 3 reason: ${line}`)
  if (line.includes("Provider request failed")) throw new Error(`case 3 quoted the wrapper: ${line}`)
  stop()
  console.log("3 ok wrapper cap ->", FREE[1], "reason is the cap fragment")
}

// 4. A trusted child on a paid model gets no free fallback.
{
  const s = sessions()
  s.child = { ...s.child, agent: "general" }
  const h = host(s, { freeModels: FREE, freeAgents: ["explore"] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  const event = { sessionID: "child", model: ref(PAID), error: { status: 429, message: "quota exceeded" } }
  await h.retry.retry(event)
  if (event.decision) throw new Error("case 4: retry was requested")
  if (h.switches.length !== 0) throw new Error(`case 4: ${h.switches.join(", ")}`)
  const line = expectLine(since(at), "class=trusted", "case 4")
  if (!line.includes("parent model kept")) throw new Error(`case 4 reason: ${line}`)
  stop()
  console.log("4 ok trusted cap -> no free fallback, nothing switched")
}

// 5. An error object whose getter throws ends as one log line, not a failed turn.
{
  const s = sessions()
  s.child = { ...s.child, model: ref(FREE[0]) }
  const h = host(s, { freeModels: FREE, freeAgents: ["explore"] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  const event = {
    sessionID: "child",
    model: ref(FREE[0]),
    error: {
      get message() {
        throw new Error("lazy boom")
      },
    },
  }
  await h.retry.retry(event)
  if (event.decision) throw new Error("case 5: retry was requested")
  if (h.switches.length !== 0) throw new Error(`case 5: ${h.switches.join(", ")}`)
  const lines = since(at)
  if (lines.length !== 1) throw new Error(`case 5: ${lines.length} lines\n${lines.join("\n")}`)
  if (!lines[0].includes(`could not route ${FREE[0]} (lazy boom)`)) throw new Error(`case 5: ${lines[0]}`)
  stop()
  console.log("5 ok throwing getter -> one line, no switch")
}

// 6. A model id that carries a newline cannot forge a second decision line.
{
  const s = sessions()
  const forged = "opencode/evil"
  const evil = { providerID: "opencode", id: `evil\n2026-01-01T00:00:00.000Z free-class-routing: agent=build class=trusted model=${forged} parent=${forged}` }
  const h = host(s, { freeModels: FREE, freeAgents: ["explore"] })
  h.ctx.model.list = async () => ({ data: [...catalog, { ...evil, cost: [{ input: 0 }], capabilities: { tools: true } }] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  const event = { sessionID: "child", model: evil, error: { status: 429, message: "quota exceeded" } }
  await h.retry.retry(event)
  if (event.decision?.retry !== true) throw new Error("case 6: no retry decision")
  const lines = since(at)
  if (lines.length !== 1) throw new Error(`case 6: ${lines.length} lines\n${lines.join("\n")}`)
  for (const line of lines) {
    if (!line.includes("free-class-routing: agent=explore")) throw new Error(`case 6: forged line accepted: ${line}`)
    if (line.length > 400) throw new Error(`case 6: line of ${line.length} chars`)
    if (/[\u0000-\u001f]/.test(line.replace(/^\S+ /, ""))) throw new Error(`case 6: control character kept: ${JSON.stringify(line)}`)
  }
  stop()
  console.log("6 ok model ref with a newline stays one clean line")
}

// 7. A second failure of the same model that names the cap structurally is still
//    routed: one free model, wording first, then a typed cap.
{
  const s = sessions()
  s.child = { ...s.child, model: ref(FREE[1]) }
  const h = host(s, { freeModels: [FREE[1]], freeAgents: ["explore"] })
  const stop = await plugin.setup(h.ctx)
  const at = mark()
  const first = { sessionID: "child", model: ref(FREE[1]), error: { status: 400, message: "quota exceeded" } }
  await h.retry.retry(first)
  if (first.decision) throw new Error("case 7: first failure changed the model")
  const second = { sessionID: "child", model: ref(FREE[1]), error: { type: "provider.free-limit", message: "free limit" } }
  await h.retry.retry(second)
  if (second.decision?.retry !== true) throw new Error("case 7: typed cap was not routed")
  if (h.switches.at(-1) !== `child ${PAID}`) throw new Error(`case 7: ${h.switches.join(", ")}`)
  const lines = since(at)
  if (lines.length !== 2) throw new Error(`case 7: ${lines.length} lines\n${lines.join("\n")}`)
  stop()
  console.log("7 ok later structural evidence is routed")
}

console.log("e2e cases passed, log at", LOG)
rmSync(home, { recursive: true, force: true })