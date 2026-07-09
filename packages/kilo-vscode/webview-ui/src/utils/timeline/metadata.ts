/**
 * Per-bar metadata resolution for the task timeline.
 *
 * Each bar is one Part, but only some part types carry their own timing or
 * usage data on the wire (see packages/opencode/src/session/message-v2.ts):
 * - text / reasoning parts have their own start (+ maybe end) time.
 * - tool parts have a start (+ end, once finished) time on their state, but
 *   no usage data.
 * - step-finish parts have model/cost/tokens, but no timestamp of their own.
 * - step-start parts have neither.
 *
 * resolveMetadata() fills these gaps by:
 * - joining model/cost/tokens from the nearest step-finish part at or after
 *   this part in the same message (the step-finish that closes the window
 *   this part belongs to), falling back to the message's own totals.
 * - interpolating a timestamp from the nearest real neighbor when a part
 *   has none of its own, marked `approx` so callers can label it as such
 *   rather than presenting it as an exact recorded time.
 */

import type { Message, Part, StepFinishPart, TokenUsage } from "../../types/messages"

export interface TimelineTimestamp {
  value: number
  end?: number
  approx: boolean
}

export interface TimelineMetadata {
  agent?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: TokenUsage
  time?: TimelineTimestamp
}

function realStart(part: Part): number | undefined {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start
  if (part.type === "tool" && part.state.status !== "pending") return part.state.time.start
  return undefined
}

function realEnd(part: Part): number | undefined {
  if (part.type === "text" || part.type === "reasoning") return part.time?.end
  if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
    return part.state.time.end
  }
  return undefined
}

function interpolateForward(parts: Part[], index: number, msg: Message): TimelineTimestamp {
  for (let i = index + 1; i < parts.length; i++) {
    const value = realStart(parts[i]!)
    if (value !== undefined) return { value, approx: true }
  }
  return { value: msg.time?.created ?? Date.now(), approx: true }
}

function interpolateBackward(parts: Part[], index: number, msg: Message): TimelineTimestamp {
  for (let i = index - 1; i >= 0; i--) {
    const end = realEnd(parts[i]!) ?? realStart(parts[i]!)
    if (end !== undefined) return { value: end, approx: true }
  }
  return { value: msg.time?.completed ?? msg.time?.created ?? Date.now(), approx: true }
}

function resolveTime(part: Part, parts: Part[], index: number, msg: Message): TimelineTimestamp | undefined {
  switch (part.type) {
    case "text":
    case "reasoning": {
      const start = part.time?.start
      if (start === undefined) return interpolateForward(parts, index, msg)
      return { value: start, end: part.time?.end, approx: false }
    }
    case "tool": {
      if (part.state.status === "pending") return interpolateForward(parts, index, msg)
      const time = part.state.time
      return { value: time.start, end: "end" in time ? time.end : undefined, approx: false }
    }
    case "step-start":
      return interpolateForward(parts, index, msg)
    case "step-finish":
      return interpolateBackward(parts, index, msg)
    default:
      return undefined
  }
}

/** The step-finish part that closes the window containing `parts[index]`. */
function nearestStepFinish(parts: Part[], index: number): StepFinishPart | undefined {
  for (let i = index; i < parts.length; i++) {
    const p = parts[i]!
    if (p.type === "step-finish") return p
  }
  return undefined
}

export function resolveMetadata(
  msgId: string,
  partId: string,
  messages: Message[],
  parts: Record<string, Part[]>,
): TimelineMetadata | undefined {
  const msg = messages.find((m) => m.id === msgId)
  if (!msg) return undefined
  const ps = parts[msgId] ?? []
  const index = ps.findIndex((p) => p.id === partId)
  if (index < 0) return undefined

  const part = ps[index]!
  const finish = nearestStepFinish(ps, index)

  return {
    agent: msg.agent,
    providerID: finish?.model?.providerID ?? msg.model?.providerID ?? msg.providerID,
    modelID: finish?.model?.modelID ?? msg.model?.modelID ?? msg.modelID,
    cost: finish?.cost ?? msg.cost,
    tokens: finish?.tokens ?? msg.tokens,
    time: resolveTime(part, ps, index, msg),
  }
}
