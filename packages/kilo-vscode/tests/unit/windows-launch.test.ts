import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { launch } from "../../src/agent-manager/providers/windows-launch"
import { execCliRead } from "../../src/agent-manager/providers/provider"

const platform = Object.getOwnPropertyDescriptor(process, "platform")!
const dirs: string[] = []

afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function windows() {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
}

/** An Azure CLI MSI layout: `<root>/wbin/az.cmd` launching `<root>/python.exe`. */
function install(launcher: string, python = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-az-"))
  dirs.push(root)
  fs.mkdirSync(path.join(root, "wbin"))
  fs.writeFileSync(path.join(root, "wbin", "az.cmd"), launcher)
  if (python) fs.writeFileSync(path.join(root, "python.exe"), "")
  return root
}

const MSI = [
  "::",
  ":: Microsoft Azure CLI - Windows Installer - Author file components script",
  "::",
  "",
  '@IF EXIST "%~dp0\\..\\python.exe" (',
  "  SET AZ_INSTALLER=MSI",
  '  "%~dp0\\..\\python.exe" -IBm azure.cli %*',
  ") ELSE (",
  "  echo Failed to load python executable.",
  "  exit /b 1",
  ")",
].join("\r\n")

describe("launch (Windows CLI resolution)", () => {
  it("runs the Azure CLI's bundled Python directly instead of its az.cmd launcher", () => {
    windows()
    const root = install(MSI)
    expect(launch("az", { PATH: path.join(root, "wbin") })).toEqual({
      bin: path.join(root, "python.exe"),
      prefix: ["-X", "utf8", "-IBm", "azure.cli"],
      env: { AZ_INSTALLER: "MSI" },
    })
  })

  it("prefers a real executable found earlier on PATH", () => {
    windows()
    const root = install(MSI)
    const exe = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-exe-"))
    dirs.push(exe)
    fs.writeFileSync(path.join(exe, "az.exe"), "")
    const found = launch("az", { Path: [exe, path.join(root, "wbin")].join(path.delimiter) })
    expect(found).toEqual({ bin: "az", prefix: [], env: {} })
  })

  it("leaves a .cmd it does not recognize, or whose Python is missing, to run as-is", () => {
    windows()
    const other = install("@echo off\r\nnode %~dp0\\cli.js %*")
    expect(launch("az", { PATH: path.join(other, "wbin") }).bin).toBe("az")
    const broken = install(MSI, false)
    expect(launch("az", { PATH: path.join(broken, "wbin") }).bin).toBe("az")
  })

  it("does nothing outside Windows", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    const root = install(MSI)
    expect(launch("az", { PATH: path.join(root, "wbin") })).toEqual({ bin: "az", prefix: [], env: {} })
  })
})

// Real Azure CLI on a Windows machine that has one: the case `execFile("az")` used to report as missing.
const installed = process.platform === "win32" && launch("az").bin.toLowerCase().endsWith("python.exe")
describe.skipIf(!installed)("execCliRead with the real Azure CLI", () => {
  it("starts az and returns its JSON output", async () => {
    const { stdout } = await execCliRead("az", ["version", "-o", "json"], { timeout: 60_000 })
    expect(JSON.parse(stdout)).toHaveProperty("azure-cli")
  }, 60_000)
})
