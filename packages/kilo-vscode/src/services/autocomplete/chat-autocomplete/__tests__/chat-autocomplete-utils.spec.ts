import { describe, it, expect } from "vitest"
import { stripPrefixEcho, finalizeChatSuggestion, buildChatPrefix } from "../chat-autocomplete-utils"

describe("stripPrefixEcho", () => {
  it("returns response unchanged when prefix is empty", () => {
    expect(stripPrefixEcho("hello world", "")).toBe("hello world")
  })

  it("returns response unchanged when response is empty", () => {
    expect(stripPrefixEcho("", "some prefix")).toBe("")
  })

  it("strips full prefix echo", () => {
    const prefix = "// User's message:\nHello! Can you"
    const response = "// User's message:\nHello! Can you help with this?"
    expect(stripPrefixEcho(response, prefix)).toBe(" help with this?")
  })

  it("strips partial prefix echo (suffix overlap)", () => {
    const prefix = "// Code context\n// User's message:\nHello"
    const response = "// User's message:\nHello world"
    expect(stripPrefixEcho(response, prefix)).toBe(" world")
  })

  it("does not strip overlaps shorter than MIN_ECHO_LEN", () => {
    const prefix = "Hello "
    const response = "lo world"
    // "lo " is only 3 chars — below the 8-char minimum
    expect(stripPrefixEcho(response, prefix)).toBe("lo world")
  })

  it("strips overlaps at exactly MIN_ECHO_LEN", () => {
    const prefix = "prefix: 12345678"
    const response = "12345678 rest"
    expect(stripPrefixEcho(response, prefix)).toBe(" rest")
  })

  it("returns response unchanged when no overlap exists", () => {
    const prefix = "completely different"
    const response = "no overlap here"
    expect(stripPrefixEcho(response, prefix)).toBe("no overlap here")
  })

  it("handles prefix longer than response with no overlap", () => {
    const prefix = "this is a very long prefix that has no shared tail"
    const response = "something entirely different"
    expect(stripPrefixEcho(response, prefix)).toBe("something entirely different")
  })

  it("handles realistic FIM echo with code context", () => {
    const prefix = "// Code visible in editor:\n// File: index.ts (typescript)\nconst x = 1\n// User's message:\nHow do I"
    const response = "// User's message:\nHow do I add types?"
    expect(stripPrefixEcho(response, prefix)).toBe(" add types?")
  })
})

describe("finalizeChatSuggestion", () => {
  it("returns empty string for empty input", () => {
    expect(finalizeChatSuggestion("")).toBe("")
  })

  it("filters suggestions that look like line comments", () => {
    expect(finalizeChatSuggestion("// this is a comment")).toBe("")
  })

  it("filters suggestions that look like block comments", () => {
    expect(finalizeChatSuggestion("/* block comment */")).toBe("")
  })

  it("filters suggestions starting with hash comments", () => {
    expect(finalizeChatSuggestion("# python comment")).toBe("")
  })

  it("truncates at first newline", () => {
    expect(finalizeChatSuggestion("first line\nsecond line")).toBe("first line")
  })

  it("trims trailing whitespace", () => {
    expect(finalizeChatSuggestion("suggestion   ")).toBe("suggestion")
  })

  it("returns normal suggestion unchanged", () => {
    expect(finalizeChatSuggestion("help with your code")).toBe("help with your code")
  })
})

describe("buildChatPrefix", () => {
  it("includes user text with message marker", () => {
    const result = buildChatPrefix("Hello", undefined)
    expect(result).toContain("// User's message:")
    expect(result).toContain("Hello")
  })

  it("includes visible editor context when provided", () => {
    const editors = [
      {
        filePath: "/src/index.ts",
        languageId: "typescript",
        visibleRanges: [{ content: "const x = 1" }],
      },
    ]
    const result = buildChatPrefix("Hello", editors)
    expect(result).toContain("// Code visible in editor:")
    expect(result).toContain("index.ts")
    expect(result).toContain("const x = 1")
    expect(result).toContain("Hello")
  })

  it("works without editors", () => {
    const result = buildChatPrefix("test", undefined)
    expect(result).not.toContain("// Code visible in editor:")
    expect(result).toContain("test")
  })
})
