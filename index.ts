/**
 * Routes a subagent session to a model by the class of its task.
 *
 * FREE class: the work is checked by a machine afterwards - a search, a fact
 * with its source, a test run, a fixture. A free model is enough.
 * TRUSTED class: the answer is taken without re-checking - a review, a plan,
 * security, anything that writes. The child keeps the model the human chose
 * for the chat.
 *
 * The trusted model is the model of the root session, read at the moment the
 * child starts. The plugin never invents one, never guesses by model name, and
 * never touches the main session.
 *
 * With no `freeAgents` option every subagent is FREE, which is the behaviour of
 * earlier versions.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Ref = { providerID: string; id: string; variant?: string }
type ModelInfo = {
  providerID: string
  id: string
  enabled?: boolean
  cost?: Array<{ input?: number }>
  capabilities?: { tools?: boolean }
  variants?: Array<{ id: string }>
}
type Verdict = { quota: boolean; hard: boolean; structural: boolean }
type ClassName = "free" | "trusted"

const TAG = "free-class-routing"

/**
 * The desktop app starts the server with a stderr nobody reads, so every line
 * is also appended to a file in the OpenCode data directory. The path is
 * resolved on every call, so a test can point the home directory elsewhere.
 */
function say(line: string) {
  console.error(line)
  try {
    const dir = join(homedir(), ".local", "share", "opencode")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "free-class-routing.log"), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A log that cannot be written must never stop a routing decision.
  }
}

/** Providers whose models can be free. */
const FREE_PROVIDERS = new Set(["opencode", "opencode-go"])

/** Error types the host assigns to an account or free-tier cap. */
const CAP_TYPES = new Set(["provider.quota", "provider.free-limit", "provider.chatgpt-limit"])

/** Wording that means a daily or free allowance is used up, not a short burst. */
const CAP_TEXT = [
  /too many tokens(?: per day)?, please wait/i,
  /free (?:usage|tier|daily) limit/i,
  /daily (?:token|request|usage) limit/i,
  /(?:token|request|usage) limit (?:reached|exceeded)/i,
  /quota (?:exceeded|exhausted)/i,
  /insufficient[-_\s]?quota/i,
  /spend limit/i,
  /budget exceeded/i,
]

const THROTTLE_TEXT = [/rate.?limit/i, /too many requests/i, /throttling error/i]

export function parseRef(value: unknown): Ref | undefined {
  if (typeof value !== "string") return
  const input = value.trim()
  const slash = input.indexOf("/")
  if (slash <= 0) return
  const hash = input.indexOf("#", slash + 1)
  const id = input.slice(slash + 1, hash === -1 ? undefined : hash)
  const variant = hash === -1 ? undefined : input.slice(hash + 1)
  if (!id || variant === "") return
  return { providerID: input.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

export function toRef(model: unknown): Ref | undefined {
  if (!model || typeof model !== "object") return
  const value = model as { providerID?: unknown; id?: unknown; variant?: unknown }
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return
  return {
    providerID: value.providerID,
    id: value.id,
    // OpenCode reports "default" as a pseudo-variant; it is not a switchable one.
    ...(typeof value.variant === "string" && value.variant !== "default" ? { variant: value.variant } : {}),
  }
}

export function keyOf(ref: Ref): string {
  return `${ref.providerID}/${ref.id}`
}

export function formatRef(ref: Ref): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

/** Same model; a variant never makes a different model for this plugin. */
export function sameModel(left: Ref | undefined, right: Ref | undefined): boolean {
  return Boolean(left && right && left.providerID === right.providerID && left.id === right.id)
}

/** Strips control characters, redacts key-shaped tokens and caps provider text. */
export function clean(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    // A provider body or a proxy message can echo the credential it rejected;
    // this file is append-only and readable by anything running as the user.
    .replace(/\b(sk|pk|rk|api|bearer)[-_ ]?[A-Za-z0-9_-]{8,}/gi, "$1-***")
    .slice(0, 200)
}

/** Keys a provider may wrap the real error in; `error`, `body` and `errors` are as common as `data`. */
const WRAPPER_KEYS = ["data", "cause", "response", "error", "body", "errors"]

/** Keeps one error, however nested or cyclic, from turning into thousands of nodes. */
const MAX_NODES = 200

/** Array entries read per array, and arrays read at all, so one long list cannot hide the rest. */
const MAX_ARRAY_ENTRIES = 50
const MAX_ARRAYS = 20

/**
 * The error itself and every object it was wrapped in. Breadth first, so the
 * nearest node wins: a status on the error outranks one buried in its `cause`.
 */
export function nodesOf(error: unknown, depth = 4): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  const seen = new Set<object>()
  let arrays = MAX_ARRAYS
  let level: unknown[] = [error]
  for (let left = depth; left > 0 && level.length > 0; left -= 1) {
    const next: unknown[] = []
    for (const node of level) {
      if (!node || typeof node !== "object" || seen.has(node) || found.length >= MAX_NODES) continue
      seen.add(node)
      const record = node as Record<string, unknown>
      if (Array.isArray(record)) {
        // An array is a container, not a wrapper; its entries are read next.
        if (arrays <= 0) continue
        arrays -= 1
        for (const entry of record.slice(0, MAX_ARRAY_ENTRIES)) next.push(entry)
        continue
      }
      found.push(record)
      for (const inner of WRAPPER_KEYS) next.push(record[inner])
    }
    level = next
  }
  return found
}

/** Every value a provider may put for a field on the error or inside the wrapper it arrived in. */
export function textsOf(error: unknown, key: "type" | "message", depth = 4): string[] {
  const found: string[] = []
  for (const node of nodesOf(error, depth)) {
    const value = node[key]
    if (typeof value === "string") found.push(value)
  }
  return found
}

/**
 * The wording that names the cap, cut to the fragment that matched, so a
 * provider sentence carrying a key is not copied into the log whole. A wrapper's
 * own text is quoted only when nothing in the tree names a cap.
 */
export function capReason(error: unknown): string {
  const nodes = nodesOf(error)
  const messages = nodes
    .map((node) => node.message)
    .filter((text): text is string => typeof text === "string")
  for (const patterns of [CAP_TEXT, THROTTLE_TEXT]) {
    for (const message of messages) {
      const hit = patterns.map((pattern) => message.match(pattern)?.[0]).find(Boolean)
      if (hit) return hit
    }
  }
  for (const node of nodes) {
    const type = node.type
    if (typeof type === "string" && CAP_TYPES.has(type)) return type
  }
  return messages[0] ?? ""
}

export function classify(error: unknown): Verdict {
  const nodes = nodesOf(error)
  const statuses = nodes
    .map((node) => node.status)
    .filter((status): status is number => typeof status === "number")
  const types = textsOf(error, "type")
  const messages = textsOf(error, "message")

  const hard =
    statuses.includes(402) ||
    types.some((type) => CAP_TYPES.has(type)) ||
    messages.some((message) => CAP_TEXT.some((p) => p.test(message)))
  // Structural evidence is a status or a typed error; wording alone next to an
  // ordinary status may be text the provider echoed back from the request.
  const structural =
    statuses.includes(402) ||
    types.some((type) => CAP_TYPES.has(type)) ||
    (hard && (statuses.length === 0 || statuses.includes(429)))
  const quota =
    hard ||
    types.includes("provider.rate-limit") ||
    statuses.includes(429) ||
    messages.some((message) => THROTTLE_TEXT.some((p) => p.test(message)))
  // A server fault or an auth failure is left to OpenCode's own retry; only a
  // cap named somewhere in the tree outranks it.
  const fault = statuses.some((status) => status >= 500 || status === 401 || status === 403 || status === 408)
  if (!hard && fault) return { quota: false, hard: false, structural: false }
  return { quota, hard, structural }
}

/** A free model has an OpenCode provider and a reported input price of zero. */
export function isAutoFree(info: ModelInfo): boolean {
  if (info.enabled === false) return false
  if (!FREE_PROVIDERS.has(info.providerID)) return false
  if (info.capabilities && info.capabilities.tools === false) return false
  // A price the catalog does not report is not a zero price.
  if (!Array.isArray(info.cost) || info.cost.length === 0) return false
  return info.cost.every((tier) => Boolean(tier) && typeof tier === "object" && tier.input === 0)
}

/** Parses the optional `freeModels` order, dropping entries that are not provider/model. */
export function parseFreeModels(value: unknown): { refs: Ref[]; invalid: string[] } {
  if (!Array.isArray(value)) return { refs: [], invalid: [] }
  const seen = new Set<string>()
  const refs: Ref[] = []
  const invalid: string[] = []
  for (const entry of value) {
    const ref = parseRef(entry)
    if (!ref) {
      invalid.push(clean(entry))
      continue
    }
    const key = keyOf(ref)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return { refs, invalid }
}

/**
 * Parses `freeAgents`, the agents whose subagents may run on a free model.
 * Absent means "every subagent is free" (the old behaviour). A malformed value
 * means "no agent is free", so a typo can never send trusted work to a free
 * model.
 */
export function parseFreeAgents(value: unknown): { agents?: Set<string>; invalid: string[] } {
  if (value === undefined) return { invalid: [] }
  if (!Array.isArray(value)) return { agents: new Set(), invalid: [clean(value)] }
  const agents = new Set<string>()
  const invalid: string[] = []
  for (const entry of value) {
    const id = typeof entry === "string" ? entry.trim() : ""
    if (id) agents.add(id)
    else invalid.push(clean(entry))
  }
  return { agents, invalid }
}

function findModel(catalog: ModelInfo[], ref: Ref): ModelInfo | undefined {
  return catalog.find((model) => model.providerID === ref.providerID && model.id === ref.id)
}

function isEnabled(model: ModelInfo | undefined, ref: Ref): boolean {
  if (!model || model.enabled === false) return false
  return !ref.variant || (model.variants || []).some((variant) => variant.id === ref.variant)
}

/** A listed model is free by the user's choice; otherwise the catalog decides. */
export function isFreeRef(ref: Ref, catalog: ModelInfo[], explicit: Set<string>): boolean {
  if (explicit.has(keyOf(ref))) return true
  const info = findModel(catalog, ref)
  return info ? isAutoFree(info) : false
}

export function freeTargets(catalog: ModelInfo[], preferred: Ref[]): Ref[] {
  if (preferred.length === 0) {
    return catalog.filter(isAutoFree).map((info) => ({ providerID: info.providerID, id: info.id }))
  }
  return preferred.filter((ref) => isEnabled(findModel(catalog, ref), ref))
}

/** True when a free model is not the one already in use and has not hit its limit today. */
export function pickFree(
  targets: Ref[],
  current: Ref | undefined,
  exhausted: (ref: Ref) => boolean,
): Ref | undefined {
  return targets.find((ref) => !exhausted(ref) && !sameModel(ref, current))
}

export default {
  id: TAG,
  async setup(ctx: any) {
    const options = ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    const parsed = parseFreeModels(options.freeModels)
    if (options.freeModels !== undefined && !Array.isArray(options.freeModels)) {
      say(`${TAG}: ignored freeModels: ${clean(options.freeModels)} (expected an array of provider/model)`)
    }
    if (parsed.invalid.length > 0) {
      say(`${TAG}: ignored ${parsed.invalid.length} freeModels entries that are not provider/model: ${parsed.invalid.join(", ")}`)
    }

    const configured = parseFreeAgents(options.freeAgents)
    if (configured.invalid.length > 0) {
      say(`${TAG}: ignored freeAgents: ${configured.invalid.join(", ")} (expected an array of agent names); every subagent is treated as trusted`)
    }
    /** undefined: every subagent is free (old behaviour); empty set: every subagent is trusted. */
    const freeAgents = configured.agents

    if (!ctx.session || typeof ctx.session.hook !== "function" || typeof ctx.session.switchModel !== "function") {
      say(`${TAG}: idle, this OpenCode has no session hooks (incompatible plugin API)`)
      return
    }
    if (!ctx.model || typeof ctx.model.list !== "function") {
      say(`${TAG}: idle, this OpenCode has no model.list (incompatible plugin API)`)
      return
    }

    const preferred = parsed.refs
    const explicit = new Set(preferred.map(keyOf))
    // Shared by every loaded copy of the plugin: a cap one copy learned is a cap
    // for all of them, and the day check in `isExhausted` still expires it.
    const exhausted: Map<string, number> = ((globalThis as any).__freeClassExhausted ??= new Map())
    const lastNotice = new Map<string, string>()
    let agentCache: Array<{ id: string; mode?: string }> | undefined
    let deadReported = false

    const notice = (sessionID: string, line: string) => {
      if (lastNotice.get(sessionID) === line) return
      lastNotice.set(sessionID, line)
      if (lastNotice.size > 200) {
        const oldest = lastNotice.keys().next()
        if (!oldest.done) lastNotice.delete(oldest.value)
      }
      say(line)
    }

    const day = () => new Date().toDateString()
    const markExhausted = (ref: Ref) => {
      exhausted.set(keyOf(ref), Date.now())
    }
    const isExhausted = (ref: Ref) => {
      const at = exhausted.get(keyOf(ref))
      if (at === undefined) return false
      if (new Date(at).toDateString() !== day()) {
        exhausted.delete(keyOf(ref))
        return false
      }
      return true
    }

    const models = async (): Promise<ModelInfo[]> => {
      const result = await ctx.model.list()
      return Array.isArray(result?.data) ? (result.data as ModelInfo[]) : []
    }

    const sessionInfo = async (sessionID: string) => {
      try {
        return await ctx.session.get({ sessionID })
      } catch {
        return undefined
      }
    }

    const agentMode = async (agentID: unknown) => {
      if (typeof agentID !== "string" || !ctx.agent || typeof ctx.agent.list !== "function") return undefined
      try {
        if (!agentCache) {
          const result = await ctx.agent.list()
          agentCache = Array.isArray(result) ? result : result?.data
        }
        return agentCache?.find((agent) => agent.id === agentID)?.mode
      } catch {
        return undefined
      }
    }

    const freeOf = (catalog: ModelInfo[]) => {
      if (preferred.length > 0 && !deadReported && catalog.length > 0) {
        deadReported = true
        const dead = preferred.filter((ref) => !isEnabled(findModel(catalog, ref), ref)).map(formatRef)
        if (dead.length > 0) say(`${TAG}: not available: ${dead.map(clean).join(", ")}`)
      }
      return freeTargets(catalog, preferred)
    }

    /** The class comes from the agent that runs the child, never from its text. */
    const classOf = (agent: unknown): ClassName => {
      if (!freeAgents) return "free"
      return typeof agent === "string" && freeAgents.has(agent) ? "free" : "trusted"
    }

    /**
     * The root of the chain the child hangs from. Its model is the human's
     * choice; a free subagent further up is not a trusted source.
     */
    const rootOf = async (sessionID: string) => {
      let id: string | undefined = sessionID
      let info: any
      for (let depth = 0; depth < 12 && id; depth++) {
        const current: any = await sessionInfo(id)
        if (!current) break
        info = current
        id = typeof current.parentID === "string" && current.parentID ? current.parentID : undefined
      }
      return info
    }

    const isSubagent = async (info: any) => {
      if (!info || typeof info.parentID !== "string" || !info.parentID || info.fork) return false
      return (await agentMode(info.agent)) !== "primary"
    }

    /**
     * Decides the model, switches when it differs, and prints the decision:
     * agent, class, chosen model, parent model, reason.
     */
    const route = async (sessionID: string, info: any, why: string, catalog: ModelInfo[], failed?: Ref) => {
      // On a retry, the model that failed is the one to leave, even when the
      // session record has not caught up with it yet.
      const current = failed ?? toRef(info?.model)
      const agent = info?.agent
      const cls = classOf(agent)
      const parent = toRef((await rootOf(sessionID))?.model)
      const parentFree = parent ? isFreeRef(parent, catalog, explicit) : false

      let chosen = current
      let reason = why

      if (parentFree) {
        // The human picked a free model for the chat; nothing here overrides it.
        reason = `${why}; parent model is free, left alone`
      } else if (cls === "free") {
        const next = pickFree(freeOf(catalog), current, isExhausted)
        if (next) {
          chosen = next
          reason = `${why}; free class, free model`
        } else if (current && isFreeRef(current, catalog, explicit) && !isExhausted(current)) {
          reason = `${why}; free class, already on a free model`
        } else if (current && !isFreeRef(current, catalog, explicit)) {
          reason = `${why}; free class, no free model available, kept the trusted one`
        } else if (parent) {
          chosen = parent
          reason = `${why}; free class, every free model is used up, parent model`
        } else {
          reason = `${why}; free class, every free model is used up, no parent model`
        }
      } else if (!parent) {
        reason = `${why}; trusted class, parent model unknown, left on the current model`
      } else if (sameModel(current, parent)) {
        reason = `${why}; trusted class, parent model kept`
      } else {
        chosen = parent
        reason = `${why}; trusted class, parent model`
      }

      const switched = Boolean(chosen && !sameModel(chosen, current))
      if (switched) await ctx.session.switchModel({ sessionID, model: chosen })
      notice(
        sessionID,
        `${TAG}: agent=${clean(agent ?? "?")} class=${cls} model=${chosen ? clean(formatRef(chosen)) : "unknown"} parent=${parent ? clean(formatRef(parent)) : "unknown"} reason=${clean(reason)}`,
      )
      return { switched, cls }
    }

    const onCreated = async (event: any) => {
      if (dead) return
      const data = event?.data ?? event?.properties ?? event
      const sessionID = data?.sessionID ?? data?.id
      if (typeof sessionID !== "string" || !sessionID) return
      if (typeof data?.parentID !== "string" || !data.parentID || data.fork) return
      // OpenCode loads a global plugin more than once per process; one routing
      // per child is enough, and the marker is shared by every instance.
      const seen: Set<string> = ((globalThis as any).__subagentRoutingSeen ??= new Set())
      if (seen.has(sessionID)) return
      seen.add(sessionID)
      if (seen.size > 1000) {
        const oldest = seen.values().next()
        if (!oldest.done) seen.delete(oldest.value)
      }
      if ((await agentMode(data.agent)) === "primary") return
      const info = (await sessionInfo(sessionID)) ?? data
      if (!(await isSubagent(info))) return
      try {
        await route(sessionID, info, "subagent started", await models())
      } catch (error) {
        // A repeated event for this child may still arrive from another copy.
        seen.delete(sessionID)
        const message = error instanceof Error ? error.message : error
        say(`${TAG}: could not prepare subagent ${clean(sessionID)} (${clean(message)})`)
      }
    }

    // 2.2.x has no model.resolve or prompt hook. The public event stream fires
    // session.created before the child is prompted, so the first request is routed.
    let dead = false
    let stop: (() => void) | undefined
    if (ctx.event && typeof ctx.event.subscribe === "function") {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ types: ["session.created"], signal: controller.signal })) {
            void onCreated(event).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : error
              say(`${TAG}: could not handle a new session (${clean(message)})`)
            })
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = error instanceof Error ? error.message : error
            say(`${TAG}: event stream stopped (${clean(message)}); subagents keep their model`)
          }
        }
      })()
      stop = () => {
        dead = true
        controller.abort()
      }
    } else {
      say(`${TAG}: no event stream; subagents keep their model`)
    }

    await ctx.session.hook("retry", async (event: any) => {
      // The host may keep a hook from a previous load of this plugin alive.
      if (dead) return
      // Every loaded copy of the plugin sees the same failure; one switch and one
      // decision line is enough, and the marker is shared by all of them.
      const handled: Set<string> = ((globalThis as any).__freeClassRetrySeen ??= new Set())
      // Everything here touches objects the provider sent: a lazy getter that
      // throws must end as one log line, not as a failed turn.
      let current: Ref | undefined
      let stamp: string | undefined
      try {
        current = toRef(event?.model)
        if (!current) return
        const verdict = classify(event?.error)
        if (!verdict.quota) return

        const info: any = await sessionInfo(event.sessionID)
        if (!(await isSubagent(info))) return

        const catalog = await models()
        const currentFree = isFreeRef(current, catalog, explicit)
        if (currentFree && !verdict.hard) return
        // A free model is parked for the day only on structural evidence; wording
        // a provider echoed back is not enough to cost a free model a day.
        if (currentFree && verdict.structural) markExhausted(current)

        // Keyed by the day and by the evidence, so a later, more actionable
        // failure of the same model is still routed once.
        stamp = `${day()}|${event.sessionID}|${formatRef(current)}|${verdict.structural ? "hard" : "words"}`
        if (handled.has(stamp)) return
        handled.add(stamp)
        if (handled.size > 1000) {
          const oldest = handled.values().next()
          if (!oldest.done) handled.delete(oldest.value)
        }

        const why = clean(capReason(event?.error))
        const reason = `${formatRef(current)} failed${why ? ` (${why})` : ""}`
        const result = await route(event.sessionID, info, reason, catalog, current)
        if (result.switched) event.decision = { retry: true, delay: 0 }
      } catch (error) {
        // Another copy may still be able to route this one.
        if (stamp) handled.delete(stamp)
        const message = error instanceof Error ? error.message : error
        say(`${TAG}: could not route ${current ? clean(formatRef(current)) : "a retry"} (${clean(message)})`)
      }
    })

    return stop
  },
}
