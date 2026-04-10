import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { SessionID, MessageID } from "@/session/schema"
import { PermissionID } from "./schema"
import { Instance } from "@/project/instance"
import { Database, eq, NotFoundError } from "@/storage/db"
import { PermissionTable } from "@/session/session.sql"
import { Identifier } from "@/id/id"
import { fn } from "@/util/fn"
import { Log } from "@/util/log"
import { ProjectID } from "@/project/schema"
import { Wildcard } from "@/util/wildcard"
import { drainCovered } from "@/kilocode/permission/drain" // kilocode_change
import { ConfigProtection } from "@/kilocode/permission/config-paths" // kilocode_change
import os from "os"
import z from "zod"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({
          permission: key,
          action: value,
          pattern: "*",
        })
        continue
      }
      // null is a delete sentinel — skip it (it only appears in patches, not in stored config)
      if (value === null) continue
      ruleset.push(
        // Filter out null entries (delete sentinels) — they don't represent real rules
        ...Object.entries(value)
          .filter(([, action]) => action !== null)
          .map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action: action as Action })),
      )
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  // kilocode_change start — inverse of fromConfig: convert rules back to config format
  /**
   * Permissions typed as PermissionAction in the config schema (scalar-only).
   * These must be serialized as "allow"/"deny"/"ask", not as { "*": "allow" }.
   */
  const SCALAR_ONLY_PERMISSIONS = new Set([
    "todowrite",
    "todoread",
    "question",
    "webfetch",
    "websearch",
    "codesearch",
    "doom_loop",
  ])

  export function toConfig(rules: Ruleset): Config.Permission {
    const result: Config.Permission = {}
    for (const rule of rules) {
      const existing = result[rule.permission]

      // Scalar-only permissions (e.g. websearch, todowrite, doom_loop) only
      // accept PermissionAction ("allow"/"deny"/"ask"), not object form.
      // Use scalar format for "*"; skip non-wildcard patterns (they can't be
      // represented in the config schema — they only work in-memory).
      if (SCALAR_ONLY_PERMISSIONS.has(rule.permission)) {
        if (rule.pattern === "*") result[rule.permission] = rule.action
        continue
      }

      if (existing === undefined || existing === null) {
        // Use object format to avoid replacing existing granular rules
        // when merged via updateGlobal (e.g. { read: "allow" } would wipe
        // { read: { "*": "ask", "src/*": "allow" } })
        result[rule.permission] = { [rule.pattern]: rule.action }
        continue
      }
      if (typeof existing === "string") {
        result[rule.permission] = { "*": existing, [rule.pattern]: rule.action }
        continue
      }
      existing[rule.pattern] = rule.action
    }
    return result
  }
  // kilocode_change end

  export const Request = z
    .object({
      id: PermissionID.zod,
      sessionID: SessionID.zod,
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: MessageID.zod,
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Approval = z.object({
    projectID: ProjectID.zod,
    patterns: z.string().array(),
  })

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: SessionID.zod,
        requestID: PermissionID.zod,
        reply: Reply,
      }),
    ),
  }

  interface PendingEntry {
    info: Request
    ruleset: Ruleset // kilocode_change
    resolve: () => void
    reject: (e: any) => void
  }

  const state = Instance.state(() => {
    const projectID = Instance.project.id
    const row = Database.use((db) =>
      db.select().from(PermissionTable).where(eq(PermissionTable.project_id, projectID)).get(),
    )
    const stored = row?.data ?? ([] as Ruleset)

    return {
      pending: new Map<PermissionID, PendingEntry>(),
      approved: stored,
      session: {} as Record<string, Ruleset>, // kilocode_change
    }
  })

  export const ask = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
    }),
    async (input) => {
      const s = await state()
      const { ruleset, ...request } = input
      const local = s.session[request.sessionID] ?? [] // kilocode_change
      // kilocode_change start — force "ask" for config file edits
      const protected_ = ConfigProtection.isRequest(request)
      // kilocode_change end
      for (const pattern of request.patterns ?? []) {
        const rule = evaluate(request.permission, pattern, ruleset, s.approved, local) // kilocode_change
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny")
          throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
        // kilocode_change start — override "allow" to "ask" for config paths
        if (rule.action === "ask" || (rule.action === "allow" && protected_)) {
          const id = input.id ?? PermissionID.ascending()
          return new Promise<void>((resolve, reject) => {
            const info: Request = {
              id,
              ...request,
              metadata: {
                ...request.metadata,
                ...(protected_ ? { [ConfigProtection.DISABLE_ALWAYS_KEY]: true } : {}),
              },
            }
            // kilocode_change end
            s.pending.set(id, {
              info,
              ruleset, // kilocode_change
              resolve,
              reject,
            })
            Bus.publish(Event.Asked, info)
          })
        }
        if (rule.action === "allow") continue
      }
    },
  )

  // kilocode_change start

  export const saveAlwaysRules = fn(
    z.object({
      requestID: PermissionID.zod,
      approvedAlways: z.string().array().optional(),
      deniedAlways: z.string().array().optional(),
    }),
    async (input) => {
      const s = await state()
      const existing = s.pending.get(input.requestID)
      if (!existing) throw new NotFoundError({ message: `Permission request ${input.requestID} not found` })

      // kilocode_change start — skip rule persistence for config file edits
      if (ConfigProtection.isRequest(existing.info)) return
      // kilocode_change end

      // Combine metadata.rules (bash hierarchy) and always (all tools).
      // Set preserves insertion order and deduplicates.
      const validRules = new Set([...(existing.info.metadata?.rules ?? []), ...existing.info.always])
      const permission = existing.info.permission

      const approvedSet = new Set(input.approvedAlways ?? [])
      const deniedSet = new Set(input.deniedAlways ?? [])
      const newRules: Ruleset = []
      for (const pattern of validRules) {
        if (approvedSet.has(pattern)) newRules.push({ permission, pattern, action: "allow" })
        if (deniedSet.has(pattern)) newRules.push({ permission, pattern, action: "deny" })
      }
      s.approved.push(...newRules)

      if (newRules.length > 0) {
        await Config.updateGlobal({ permission: toConfig(newRules) }, { dispose: false })
      }

      await drainCovered(s.pending, s.approved, evaluate, Event, DeniedError, input.requestID) // kilocode_change
    },
  )
  // kilocode_change end

  export const reply = fn(
    z.object({
      requestID: PermissionID.zod,
      reply: Reply,
      message: z.string().optional(),
    }),
    async (input) => {
      const s = await state()
      const existing = s.pending.get(input.requestID)
      if (!existing) return
      s.pending.delete(input.requestID)
      Bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
        // Reject all other pending permissions for this session
        const sessionID = existing.info.sessionID
        for (const [id, pending] of s.pending) {
          if (pending.info.sessionID === sessionID) {
            s.pending.delete(id)
            Bus.publish(Event.Replied, {
              sessionID: pending.info.sessionID,
              requestID: pending.info.id,
              reply: "reject",
            })
            pending.reject(new RejectedError())
          }
        }
        return
      }
      if (input.reply === "once") {
        existing.resolve()
        return
      }
      if (input.reply === "always") {
        // kilocode_change start — downgrade "always" to "once" for config file edits
        if (ConfigProtection.isRequest(existing.info)) {
          existing.resolve()
          return
        }
        // kilocode_change end

        for (const pattern of existing.info.always) {
          s.approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        existing.resolve()

        const sessionID = existing.info.sessionID
        for (const [id, pending] of s.pending) {
          if (pending.info.sessionID !== sessionID) continue
          const ok = pending.info.patterns.every(
            (pattern) => evaluate(pending.info.permission, pattern, pending.ruleset, s.approved).action === "allow", // kilocode_change — include original ruleset
          )
          if (!ok) continue
          s.pending.delete(id)
          Bus.publish(Event.Replied, {
            sessionID: pending.info.sessionID,
            requestID: pending.info.id,
            reply: "always",
          })
          pending.resolve()
        }

        // TODO: we don't save the permission ruleset to disk yet until there's
        // UI to manage it
        // db().insert(PermissionTable).values({ projectID: Instance.project.id, data: s.approved })
        //   .onConflictDoUpdate({ target: PermissionTable.projectID, set: { data: s.approved } }).run()
        // kilocode_change start - persist always rules to global config
        const alwaysRules: Ruleset = existing.info.always.map((pattern) => ({
          permission: existing.info.permission,
          pattern,
          action: "allow" as const,
        }))
        if (alwaysRules.length > 0) {
          await Config.updateGlobal({ permission: toConfig(alwaysRules) }, { dispose: false })
        }
        // kilocode_change end
        return
      }
    },
  )

  // kilocode_change start
  export const allowEverything = fn(
    z.object({
      enable: z.boolean(),
      requestID: Identifier.schema("permission").optional(),
      sessionID: Identifier.schema("session").optional(),
    }),
    async (input) => {
      const s = await state()

      if (!input.enable) {
        if (input.sessionID) {
          delete s.session[input.sessionID]
          return
        }
        const idx = s.approved.findLastIndex((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
        if (idx >= 0) s.approved.splice(idx, 1)
        return
      }

      const rule = { permission: "*", pattern: "*", action: "allow" } as const
      if (input.sessionID) s.session[input.sessionID] = [rule]
      else s.approved.push(rule)

      if (input.requestID) {
        const existing = s.pending.get(PermissionID.make(input.requestID))
        if (existing && (!input.sessionID || existing.info.sessionID === input.sessionID)) {
          s.pending.delete(PermissionID.make(input.requestID))
          Bus.publish(Event.Replied, {
            sessionID: existing.info.sessionID,
            requestID: existing.info.id,
            reply: "once",
          })
          existing.resolve()
        }
      }

      for (const [id, entry] of s.pending) {
        if (input.sessionID && entry.info.sessionID !== input.sessionID) continue
        if (ConfigProtection.isRequest(entry.info)) continue
        s.pending.delete(id)
        Bus.publish(Event.Replied, {
          sessionID: entry.info.sessionID,
          requestID: entry.info.id,
          reply: "once",
        })
        entry.resolve()
      }
    },
  )
  // kilocode_change end

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets)
    log.info("evaluate", { permission, pattern, ruleset: merged })
    const match = merged.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
    return match ?? { action: "ask", permission, pattern: "*" }
  }

  const EDIT_TOOLS = ["edit", "write", "patch", "multiedit"]

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool

      const rule = ruleset.findLast((r) => Wildcard.match(permission, r.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected permission to use this specific tool call.`)
    }
  }

  /** User rejected with message - continues with guidance */
  export class CorrectedError extends Error {
    constructor(message: string) {
      super(`The user rejected permission to use this specific tool call with the following feedback: ${message}`)
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super(
        `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(ruleset)}`,
      )
    }
  }

  export async function list() {
    const s = await state()
    return Array.from(s.pending.values(), (x) => x.info)
  }

  // kilocode_change start
  export async function pending(id: string): Promise<Request | undefined> {
    const s = await state()
    return s.pending.get(PermissionID.make(id))?.info
  }
  // kilocode_change end
}
