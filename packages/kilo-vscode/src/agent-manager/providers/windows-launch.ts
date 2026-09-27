import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"

export interface Launch {
  bin: string
  prefix: string[]
  env: Record<string, string>
}

const cache = new Map<string, Launch>()

function search(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path")
  return (key ? (env[key] ?? "") : "").split(path.delimiter).filter(Boolean)
}

/**
 * Reads a `.cmd` launcher that only starts a bundled Python, like the Azure CLI MSI's `az.cmd`:
 *
 *   SET AZ_INSTALLER=MSI
 *   "%~dp0\..\python.exe" -IBm azure.cli %*
 */
function script(file: string): Launch | undefined {
  const text = readFileSync(file, "utf8")
  const match = /"%~dp0([^"]*python\.exe)"\s+([^%\r\n]*?)\s*%\*/i.exec(text)
  if (!match) return undefined
  const python = path.resolve(path.dirname(file), match[1]!.replace(/^[\\/]+/, ""))
  if (!existsSync(python)) return undefined
  const env = Object.fromEntries(
    [...text.matchAll(/^\s*@?SET\s+(\w+)=(\S+)\s*$/gim)].map((item) => [item[1]!, item[2]!]),
  )
  // UTF-8 mode, so names with non-ASCII characters are not decoded as the console code page.
  return { bin: python, prefix: ["-X", "utf8", ...match[2]!.trim().split(/\s+/)], env }
}

function resolve(bin: string, env: NodeJS.ProcessEnv): Launch {
  const plain = { bin, prefix: [], env: {} }
  for (const dir of search(env)) {
    if (existsSync(path.join(dir, `${bin}.exe`))) return plain
    const file = path.join(dir, `${bin}.cmd`)
    if (existsSync(file)) return script(file) ?? plain
  }
  return plain
}

/**
 * How to start a provider CLI on Windows. `execFile` cannot run a `.cmd` file without a shell, and a
 * shell cannot safely quote branch and project names, so a launcher script that just starts a
 * bundled Python (the Azure CLI's `az.cmd`) is replaced by that Python command. Anything else,
 * including a real `.exe` such as `glab.exe`, runs as-is.
 */
export function launch(bin: string, env: NodeJS.ProcessEnv = process.env): Launch {
  if (process.platform !== "win32") return { bin, prefix: [], env: {} }
  const key = `${bin}\0${search(env).join(path.delimiter)}`
  const hit = cache.get(key)
  if (hit) return hit
  const found = resolve(bin, env)
  cache.set(key, found)
  return found
}
