// kilocode_change file added
import type { MermaidConfig } from "mermaid"

export const MERMAID_THEME = {
  background: "#1e1e1e",
  textColor: "#ffffff",
  mainBkg: "#2d2d2d",
  nodeBorder: "#888888",
  lineColor: "#cccccc",
  primaryColor: "#3c3c3c",
  primaryTextColor: "#ffffff",
  primaryBorderColor: "#888888",
  secondaryColor: "#2d2d2d",
  tertiaryColor: "#454545",
  classText: "#ffffff",
  labelColor: "#ffffff",
  actorLineColor: "#cccccc",
  actorBkg: "#2d2d2d",
  actorBorder: "#888888",
  actorTextColor: "#ffffff",
  fillType0: "#2d2d2d",
  fillType1: "#3c3c3c",
  fillType2: "#454545",
}

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "antiscript",
  theme: "dark",
  suppressErrorRendering: true,
  themeVariables: {
    ...MERMAID_THEME,
    fontSize: "16px",
    fontFamily: "var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif)",
    noteTextColor: "#ffffff",
    noteBkgColor: "#454545",
    noteBorderColor: "#888888",
    critBorderColor: "#ff9580",
    critBkgColor: "#803d36",
    taskTextColor: "#ffffff",
    taskTextOutsideColor: "#ffffff",
    taskTextLightColor: "#ffffff",
    sectionBkgColor: "#2d2d2d",
    sectionBkgColor2: "#3c3c3c",
    altBackground: "#2d2d2d",
    linkColor: "#6cb6ff",
    compositeBackground: "#2d2d2d",
    compositeBorder: "#888888",
    titleColor: "#ffffff",
  },
}

type MermaidModule = typeof import("mermaid")["default"]
let mermaidModule: MermaidModule | undefined

async function getMermaid(): Promise<MermaidModule> {
  if (!mermaidModule) {
    mermaidModule = (await import("mermaid")).default
    mermaidModule.initialize(MERMAID_CONFIG)
  }
  return mermaidModule
}

export async function parseMermaid(code: string): Promise<void> {
  const mermaid = await getMermaid()
  await mermaid.parse(code)
}

export async function renderMermaid(id: string, code: string): Promise<{ svg: string }> {
  const mermaid = await getMermaid()
  return mermaid.render(id, code)
}

export async function svgToPng(svgEl: SVGElement): Promise<string> {
  const svgClone = svgEl.cloneNode(true) as SVGElement
  const viewBox = svgClone.getAttribute("viewBox")?.split(" ").map(Number) ?? []
  const originalWidth = viewBox[2] || svgClone.clientWidth
  const originalHeight = viewBox[3] || svgClone.clientHeight
  const editorWidth = 3_600
  const scale = editorWidth / originalWidth
  const scaledHeight = originalHeight * scale
  svgClone.setAttribute("width", `${editorWidth}`)
  svgClone.setAttribute("height", `${scaledHeight}`)
  const serializer = new XMLSerializer()
  const svgString = serializer.serializeToString(svgClone)
  const encodedSvg = encodeURIComponent(svgString).replace(/'/g, "%27").replace(/"/g, "%22")
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodedSvg}`

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = editorWidth
      canvas.height = scaledHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) return reject(new Error("Canvas context not available"))
      ctx.fillStyle = MERMAID_THEME.background
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"
      ctx.drawImage(img, 0, 0, editorWidth, scaledHeight)
      resolve(canvas.toDataURL("image/png", 1.0))
    }
    img.onerror = reject
    img.src = svgDataUrl
  })
}

/** Apply simple deterministic fixes for common LLM encoding errors. */
export function applyDeterministicFixes(code: string): string {
  return code.replace(/--&gt;/g, "-->").replace(/```mermaid/, "")
}

/** VS Code-specific integration (optional — not provided in non-VS Code contexts). */
export interface MermaidAPI {
  openImage?: (dataUrl: string) => void
  saveImage?: (dataUrl: string) => void
  fixSyntax?: (code: string, error: string) => Promise<string>
}

// Use window as shared storage so configureMermaid and getMermaidAPI always
// refer to the same object even when Vite creates multiple module instances
// (e.g. one for the @opencode-ai/ui/mermaid path and one for ./mermaid).
const WIN_KEY = "__kiloMermaidAPI"

export function configureMermaid(config: MermaidAPI): void {
  const current: MermaidAPI = (window as any)[WIN_KEY] ?? {}
  ;(window as any)[WIN_KEY] = { ...current, ...config }
}

export function getMermaidAPI(): MermaidAPI {
  return (window as any)[WIN_KEY] ?? {}
}
