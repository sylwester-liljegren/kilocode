import { readFile, writeFile, mkdir } from "fs/promises"
import { readFileSync } from "fs"
import { dirname } from "path"
import jschardet from "jschardet"
import iconv from "iconv-lite"

/**
 * Text encoding detection and preservation for tool file I/O.
 *
 * Supported:
 *  - UTF-8 (with or without BOM)
 *  - UTF-16 LE/BE with BOM (detected by jschardet)
 *  - Legacy Latin and CJK encodings (detected by jschardet)
 *
 * Not supported:
 *  - UTF-16 without BOM (ambiguous, rare)
 *  - UTF-32 (extremely rare)
 *
 * Detection strategy:
 *  1. If the bytes are valid UTF-8, treat as UTF-8.
 *  2. Otherwise, trust jschardet. iconv-lite handles BOM stripping on decode
 *     and BOM emission on encode for UTF-16 LE/BE, so explicit BOM handling
 *     is unnecessary.
 */
export namespace Encoding {
  export const DEFAULT = "utf-8"

  /** Remap jschardet labels to iconv-lite compatible names. */
  function normalize(name: string): string {
    const lower = name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const map: Record<string, string> = {
      utf8: "utf-8",
      utf16le: "utf-16le",
      utf16be: "utf-16be",
      ascii: "utf-8",
      iso88591: "iso-8859-1",
      iso88592: "iso-8859-2",
      iso88595: "iso-8859-5",
      iso88597: "iso-8859-7",
      iso88598: "iso-8859-8",
      iso88599: "iso-8859-9",
      windows1250: "windows-1250",
      windows1251: "windows-1251",
      windows1252: "windows-1252",
      windows1253: "windows-1253",
      windows1255: "windows-1255",
      shiftjis: "Shift_JIS",
      eucjp: "euc-jp",
      iso2022jp: "iso-2022-jp",
      euckr: "euc-kr",
      iso2022kr: "iso-2022-kr",
      big5: "big5",
      gb2312: "gb2312",
      gb18030: "gb18030",
      koi8r: "koi8-r",
      maccyrillic: "x-mac-cyrillic",
      ibm855: "cp855",
      ibm866: "cp866",
      tis620: "tis-620",
    }
    return map[lower] ?? name
  }

  function isUtf8(bytes: Buffer): boolean {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return true
    } catch {
      return false
    }
  }

  export function detect(bytes: Buffer): string {
    if (bytes.length === 0) return DEFAULT
    if (isUtf8(bytes)) return DEFAULT
    const result = jschardet.detect(bytes)
    if (!result.encoding) return DEFAULT
    const enc = normalize(result.encoding)
    // Reject unsupported Unicode encodings
    if (enc.startsWith("utf-32")) return DEFAULT
    if (!iconv.encodingExists(enc)) return DEFAULT
    return enc
  }

  export function decode(bytes: Buffer, encoding: string): string {
    return iconv.decode(bytes, encoding)
  }

  export function encode(text: string, encoding: string): Buffer {
    // iconv-lite's utf-16le/utf-16be do not emit a BOM, but UTF-16 without a
    // BOM is unsupported in this codebase. Prepend the appropriate BOM so the
    // next detection pass can still recognise the encoding.
    const lower = encoding.toLowerCase()
    if (lower === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, encoding)])
    if (lower === "utf-16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, encoding)])
    return iconv.encode(text, encoding)
  }

  /** Read a file, detecting its encoding. */
  export async function read(path: string): Promise<{ text: string; encoding: string }> {
    const bytes = Buffer.from(await readFile(path))
    const encoding = detect(bytes)
    return { text: decode(bytes, encoding), encoding }
  }

  /** Synchronous read, detecting encoding. */
  export function readSync(path: string): { text: string; encoding: string } {
    const bytes = readFileSync(path)
    const encoding = detect(bytes)
    return { text: decode(bytes, encoding), encoding }
  }

  /** Write text, ensuring parent directory exists, using the given encoding. */
  export async function write(path: string, text: string, encoding: string = DEFAULT): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, encode(text, encoding))
  }
}
