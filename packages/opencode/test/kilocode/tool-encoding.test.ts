// kilocode_change - new file
// Integration tests verifying that the agent file tools (read, write, edit,
// apply_patch) detect and preserve the original encoding of files on disk.
// Tests exercise the real tool pipeline rather than the Encoding helper
// directly so we validate end-to-end behaviour.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import iconv from "iconv-lite"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "../../src/filesystem"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { EditTool } from "../../src/tool/edit"
import { FileTime } from "../../src/file/time"
import { Format } from "../../src/format"
import { Instance } from "../../src/project/instance"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "../../src/lsp"
import { MessageID, SessionID } from "../../src/session/schema"
import { ReadTool } from "../../src/tool/read"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-encoding"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    FileTime.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const runRead = (args: Tool.InferParameters<typeof ReadTool>) =>
  Effect.gen(function* () {
    const info = yield* ReadTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

const runWrite = (args: Tool.InferParameters<typeof WriteTool>) =>
  Effect.gen(function* () {
    const info = yield* WriteTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

const runEdit = (args: Tool.InferParameters<typeof EditTool>) =>
  Effect.gen(function* () {
    const info = yield* EditTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

const runPatch = (args: Tool.InferParameters<typeof ApplyPatchTool>) =>
  Effect.gen(function* () {
    const info = yield* ApplyPatchTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

const markRead = (filepath: string) =>
  Effect.gen(function* () {
    const ft = yield* FileTime.Service
    yield* ft.read(ctx.sessionID, filepath)
  })

// iconv-lite's utf-16le/utf-16be do not emit a BOM on their own, but this
// codebase only supports UTF-16 with BOM. Prepend one for fixture files.
const encodeBytes = (text: string, encoding: string): Buffer => {
  const lower = encoding.toLowerCase()
  if (lower === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, encoding)])
  if (lower === "utf-16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, encoding)])
  return iconv.encode(text, encoding)
}

// Create a file with the given encoding by writing raw bytes.
const putEncoded = (filepath: string, text: string, encoding: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await fs.writeFile(filepath, encodeBytes(text, encoding))
  })

const loadDecoded = (filepath: string, encoding: string) =>
  Effect.promise(async () => {
    const bytes = await fs.readFile(filepath)
    return iconv.decode(bytes, encoding)
  })

const loadBytes = (filepath: string) => Effect.promise(() => fs.readFile(filepath))

// Sample phrases chosen to exercise each encoding's characteristic byte patterns.
const samples = {
  utf8: "Hello, world! — £100",
  shiftJis: "こんにちは、世界！日本語のテストです。",
  eucJp: "日本語のEUC-JPテスト文字列です。",
  gb2312: "你好，世界！这是简体中文测试。",
  big5: "你好，世界！這是繁體中文測試。",
  eucKr: "안녕하세요, 세계! 한국어 테스트입니다.",
  windows1251: "Привет, мир! Это тест кириллицы.",
  koi8r: "Привет, мир! КОИ-8 Р тест.",
  latin1: "Caf\u00e9 na\u00efve r\u00e9sum\u00e9 — \u00a3100",
}

describe("tool encoding preservation", () => {
  describe("ReadTool decodes files with non-UTF-8 encodings", () => {
    const cases: Array<[string, string, string]> = [
      ["UTF-8", "utf-8", samples.utf8],
      ["UTF-16 LE with BOM", "utf-16le", samples.utf8],
      ["UTF-16 BE with BOM", "utf-16be", samples.utf8],
      ["Shift_JIS", "Shift_JIS", samples.shiftJis],
      ["EUC-JP", "euc-jp", samples.eucJp],
      ["GB2312", "gb2312", samples.gb2312],
      ["Big5", "big5", samples.big5],
      ["EUC-KR", "euc-kr", samples.eucKr],
      ["Windows-1251", "windows-1251", samples.windows1251],
      ["KOI8-R", "koi8-r", samples.koi8r],
    ]

    for (const [label, encoding, text] of cases) {
      it.live(`decodes ${label} content for the model`, () =>
        providEncoded(encoding, text, (filepath) =>
          Effect.gen(function* () {
            const result = yield* runRead({ filePath: filepath })
            expect(result.output).toContain(text)
          }),
        ),
      )
    }
  })

  describe("ReadTool does not flag non-Latin text files as binary", () => {
    it.live("accepts Shift_JIS", () =>
      providEncoded("Shift_JIS", samples.shiftJis, (filepath) =>
        Effect.gen(function* () {
          const result = yield* runRead({ filePath: filepath })
          expect(result.output).toContain(samples.shiftJis)
        }),
      ),
    )

    it.live("accepts UTF-16 LE with BOM (contains NUL bytes)", () =>
      providEncoded("utf-16le", samples.utf8, (filepath) =>
        Effect.gen(function* () {
          const result = yield* runRead({ filePath: filepath })
          expect(result.output).toContain(samples.utf8)
        }),
      ),
    )
  })

  describe("WriteTool preserves existing file encoding when overwriting", () => {
    const cases: Array<[string, string, string]> = [
      ["Shift_JIS", "Shift_JIS", samples.shiftJis],
      ["GB2312", "gb2312", samples.gb2312],
      ["Windows-1251", "windows-1251", samples.windows1251],
      ["UTF-16 LE", "utf-16le", samples.utf8],
    ]

    for (const [label, encoding, original] of cases) {
      it.live(`preserves ${label} encoding on overwrite`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "file.txt")
            yield* putEncoded(filepath, original, encoding)
            yield* markRead(filepath)

            const replacement = original + " updated"
            yield* runWrite({ filePath: filepath, content: replacement })

            const decoded = yield* loadDecoded(filepath, encoding)
            expect(decoded).toBe(replacement)

            // Bytes should still match the original encoding (and differ from UTF-8).
            const bytes = yield* loadBytes(filepath)
            expect(bytes.equals(encodeBytes(replacement, encoding))).toBe(true)
          }),
        ),
      )
    }

    it.live("defaults new files to UTF-8", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "new.txt")
          yield* runWrite({ filePath: filepath, content: samples.utf8 })

          const bytes = yield* loadBytes(filepath)
          expect(bytes.equals(Buffer.from(samples.utf8, "utf-8"))).toBe(true)
        }),
      ),
    )
  })

  describe("EditTool preserves existing file encoding across edits", () => {
    const cases: Array<[string, string, string, string, string]> = [
      ["Shift_JIS", "Shift_JIS", samples.shiftJis, "日本語", "ニホンゴ"],
      ["GB2312", "gb2312", samples.gb2312, "简体中文", "中文简体"],
      ["Windows-1251", "windows-1251", samples.windows1251, "мир", "планета"],
      ["UTF-16 LE", "utf-16le", samples.utf8 + "\n second line", "world", "earth"],
    ]

    for (const [label, encoding, original, oldString, newString] of cases) {
      it.live(`preserves ${label} through edit`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "doc.txt")
            yield* putEncoded(filepath, original, encoding)
            yield* markRead(filepath)

            yield* runEdit({ filePath: filepath, oldString, newString })

            const decoded = yield* loadDecoded(filepath, encoding)
            const expected = original.replace(oldString, newString)
            expect(decoded).toBe(expected)

            const bytes = yield* loadBytes(filepath)
            expect(bytes.equals(encodeBytes(expected, encoding))).toBe(true)
          }),
        ),
      )
    }
  })

  describe("ApplyPatchTool preserves encoding", () => {
    it.live("preserves Shift_JIS through an update hunk", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "doc.txt")
          const original = "line1\n" + samples.shiftJis + "\nline3\n"
          yield* putEncoded(filepath, original, "Shift_JIS")

          const patch = [
            "*** Begin Patch",
            "*** Update File: doc.txt",
            "@@",
            " line1",
            "-" + samples.shiftJis,
            "+" + samples.eucJp.replace(/[^\u3000-\u30ff\u4e00-\u9fff]/g, ""),
            " line3",
            "*** End Patch",
          ].join("\n")

          yield* runPatch({ patchText: patch })

          const decoded = yield* loadDecoded(filepath, "Shift_JIS")
          expect(decoded).toContain("line1")
          expect(decoded).toContain("line3")

          // File must still decode as Shift_JIS — UTF-8 bytes would mojibake here.
          const bytes = yield* loadBytes(filepath)
          expect(bytes.includes(Buffer.from([0xe3, 0x81]))).toBe(false)
        }),
      ),
    )

    it.live("new files added via apply_patch are UTF-8", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const patch = ["*** Begin Patch", "*** Add File: new.txt", "+hello world", "*** End Patch"].join("\n")
          yield* runPatch({ patchText: patch })
          const bytes = yield* loadBytes(path.join(dir, "new.txt"))
          expect(bytes.equals(Buffer.from("hello world\n", "utf-8"))).toBe(true)
        }),
      ),
    )
  })
})

// Shared helper to set up a temp instance with an encoded file at `file.txt`.
function providEncoded<A, E, R>(encoding: string, text: string, body: (filepath: string) => Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const filepath = path.join(dir, "file.txt")
      yield* putEncoded(filepath, text, encoding)
      yield* markRead(filepath)
      return yield* body(filepath)
    }),
  )
}
