// kilocode_change file added
import { createSignal, createEffect, onCleanup, onMount, Show, type Component } from "solid-js"
import { render } from "solid-js/web"
import { useI18n } from "../context/i18n"
import { parseMermaid, renderMermaid, svgToPng, applyDeterministicFixes, getMermaidAPI } from "./mermaid"

const MIN_ZOOM = 0.5
const MAX_ZOOM = 20
const RENDER_DEBOUNCE_MS = 500
const COPY_FEEDBACK_MS = 2000

// Inline SVG paths (20×20 viewBox) — no external font dependency.
const ICONS = {
  expand:   '<path stroke="currentColor" stroke-linecap="round" d="M3 8V4h4M13 4h4v4M3 12v4h4M13 16h4v-4"/>',
  code:     '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M7 6 3 10l4 4M13 6l4 4-4 4"/>',
  copy:     '<path stroke="currentColor" stroke-linecap="round" d="M6.25 6.25V2.92h10.83V13.75H13.75M13.75 6.25V17.08H2.92V6.25h10.83Z"/>',
  check:    '<path stroke="currentColor" stroke-linecap="square" d="M5 11.97 8.38 14.75 15 5.83"/>',
  save:     '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 13V4M6 9l4 4 4-4M4 16h12"/>',
  close:    '<path stroke="currentColor" stroke-linecap="round" d="m5 5 10 10M15 5 5 15"/>',
  warning:  '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 3 2 17h16L10 3ZM10 9v4M10 14.5v.5"/>',
  chevronDown: '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m5 8 5 5 5-5"/>',
  chevronUp:   '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m5 12-5-5-5 5" transform="translate(10 5)"/>',
  wand:     '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m3 17 9-9m0 0 2-4 2 4 4 2-4 2-2 4-2-4-4-2ZM13 8l2-2"/>',
  graph:    '<circle cx="5" cy="10" r="2" stroke="currentColor"/><circle cx="15" cy="5" r="2" stroke="currentColor"/><circle cx="15" cy="15" r="2" stroke="currentColor"/><path stroke="currentColor" d="m7 9 6-3M7 11l6 3"/>',
  minus:    '<path stroke="currentColor" stroke-linecap="round" d="M4 10h12"/>',
  plus:     '<path stroke="currentColor" stroke-linecap="round" d="M10 4v12M4 10h12"/>',
} as const

type IconName = keyof typeof ICONS

function Icon(props: { name: IconName; size?: number }) {
  const s = props.size ?? 16
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ display: "block", "flex-shrink": "0" }}
      innerHTML={ICONS[props.name]}
    />
  )
}

interface MermaidBlockProps {
  code: string
  container: HTMLElement
}

// Persists rendered SVGs across component remounts (e.g. when morphdom
// replaces the container during streaming). Keyed by trimmed mermaid source.
const svgCache = new Map<string, string>()

const MermaidBlock: Component<MermaidBlockProps> = (props) => {
  const i18n = useI18n()
  const t = (key: string, params?: Record<string, string | number | boolean>) => i18n.t(key as any, params)

  const initialCode = props.code.trim()
  const initialSvg = svgCache.get(initialCode) ?? ""
  const [displayCode, setDisplayCode] = createSignal(initialCode)
  const [svgContent, setSvgContent] = createSignal(initialSvg)
  const [error, setError] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(!initialSvg)
  const [isErrorExpanded, setIsErrorExpanded] = createSignal(false)
  const [isHovering, setIsHovering] = createSignal(false)
  const [showModal, setShowModal] = createSignal(false)
  const [modalViewMode, setModalViewMode] = createSignal<"diagram" | "code">("diagram")
  const [zoomLevel, setZoomLevel] = createSignal(1)
  const [isDragging, setIsDragging] = createSignal(false)
  const [dragPosition, setDragPosition] = createSignal({ x: 0, y: 0 })
  const [copyFeedback, setCopyFeedback] = createSignal(false)
  const [copyErrorFeedback, setCopyErrorFeedback] = createSignal(false)

  let svgContainerRef: HTMLDivElement | undefined
  let copyTimeout: ReturnType<typeof setTimeout>
  let copyErrorTimeout: ReturnType<typeof setTimeout>
  let renderGen = 0

  onCleanup(() => {
    clearTimeout(copyTimeout)
    clearTimeout(copyErrorTimeout)
  })

  // Watches data-mermaid-code on the outer container so morphdom attribute
  // patches during streaming propagate into the Solid.js reactive tree.
  onMount(() => {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === "data-mermaid-code") {
          const encoded = props.container.getAttribute("data-mermaid-code") ?? ""
          setDisplayCode(decodeURIComponent(encoded).trim())
        }
      }
    })
    observer.observe(props.container, { attributes: true, attributeFilter: ["data-mermaid-code"] })
    onCleanup(() => observer.disconnect())
  })

  // 500ms debounce prevents thrashing while the LLM streams mermaid tokens.
  // Clearing error immediately on each code change ensures parse failures from
  // partial/incomplete code (mid-stream) never linger into the next token.
  // Only enter loading state when no SVG is shown yet — avoids a visible
  // opacity flash when the code gains a trailing newline as the fenced block
  // closes (the diagram content itself hasn't changed).
  createEffect(() => {
    const code = displayCode()
    setError(null)
    const cached = svgCache.get(code)
    if (cached) {
      setSvgContent(cached)
      setIsLoading(false)
    } else if (!svgContent()) {
      setIsLoading(true)
    }
    const gen = ++renderGen
    const timer = setTimeout(async () => {
      try {
        await parseMermaid(code)
        if (gen !== renderGen) return
        const id = `mermaid-${Math.random().toString(36).substring(2)}`
        const { svg } = await renderMermaid(id, code)
        if (gen !== renderGen) return
        setError(null)
        svgCache.set(code, svg)
        setSvgContent(svg)
      } catch (err) {
        if (gen !== renderGen) return
        const msg = err instanceof Error ? err.message : t("ui.mermaid.renderError")
        setError(msg)
      } finally {
        if (gen === renderGen) setIsLoading(false)
      }
    }, RENDER_DEBOUNCE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  const handleSvgClick = async () => {
    if (!svgContainerRef) return
    const svgEl = svgContainerRef.querySelector("svg")
    if (!svgEl) return
    const api = getMermaidAPI()
    if (!api.openImage) return
    try {
      const png = await svgToPng(svgEl)
      api.openImage(png)
    } catch (err) {
      console.error("[Kilo] Mermaid: error converting SVG to PNG:", err)
    }
  }

  const handleCopyCode = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(displayCode())
      setCopyFeedback(true)
      clearTimeout(copyTimeout)
      copyTimeout = setTimeout(() => setCopyFeedback(false), COPY_FEEDBACK_MS)
    } catch (err) {
      console.error("[Kilo] Mermaid: copy failed:", err)
    }
  }

  const handleCopyDiagram = async (e: MouseEvent) => {
    e.stopPropagation()
    if (!svgContainerRef) return
    const svgEl = svgContainerRef.querySelector("svg")
    if (!svgEl) return
    try {
      const png = await svgToPng(svgEl)
      const blob = await (await fetch(png)).blob()
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      setCopyFeedback(true)
      clearTimeout(copyTimeout)
      copyTimeout = setTimeout(() => setCopyFeedback(false), COPY_FEEDBACK_MS)
    } catch (err) {
      console.error("[Kilo] Mermaid: copy diagram failed:", err)
    }
  }

  const handleCopyError = async (e: MouseEvent) => {
    e.stopPropagation()
    const content = `Error: ${error()}\n\n\`\`\`mermaid\n${displayCode()}\n\`\`\``
    try {
      await navigator.clipboard.writeText(content)
      setCopyErrorFeedback(true)
      clearTimeout(copyErrorTimeout)
      copyErrorTimeout = setTimeout(() => setCopyErrorFeedback(false), COPY_FEEDBACK_MS)
    } catch (err) {
      console.error("[Kilo] Mermaid: copy error failed:", err)
    }
  }

  const handleSave = async (e: MouseEvent) => {
    e.stopPropagation()
    if (!svgContainerRef) return
    const svgEl = svgContainerRef.querySelector("svg")
    if (!svgEl) return
    const api = getMermaidAPI()
    if (!api.saveImage) return
    try {
      const png = await svgToPng(svgEl)
      api.saveImage(png)
    } catch (err) {
      console.error("[Kilo] Mermaid: save failed:", err)
    }
  }

  const [isFixing, setIsFixing] = createSignal(false)

  const MAX_FIX_ATTEMPTS = 3

  const handleApplyFixes = async (e: MouseEvent) => {
    e.stopPropagation()
    if (isFixing()) return

    const fixSyntax = getMermaidAPI().fixSyntax
    setIsFixing(true)
    try {
      let code = applyDeterministicFixes(displayCode())
      if (fixSyntax) {
        // Use renderMermaid directly to check validity inside the loop —
        // more reliable than parseMermaid across mermaid versions, and
        // avoids waiting for the 500ms reactive debounce between attempts.
        for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS; attempt++) {
          try {
            const id = `mermaid-fix-${Math.random().toString(36).substring(2)}`
            await renderMermaid(id, code)
            break // rendered successfully — stop
          } catch (renderErr) {
            if (attempt === MAX_FIX_ATTEMPTS - 1) break // no more attempts
            const errMsg = renderErr instanceof Error ? renderErr.message : t("ui.mermaid.renderError")
            const fixed = await fixSyntax(code, errMsg)
            code = applyDeterministicFixes(fixed)
          }
        }
      }
      setDisplayCode(code)
    } catch {
      setDisplayCode(applyDeterministicFixes(displayCode()))
    } finally {
      setIsFixing(false)
    }
  }

  const adjustZoom = (amount: number) => {
    setZoomLevel((prev) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + amount)))
  }

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    adjustZoom(e.deltaY > 0 ? -0.2 : 0.2)
  }

  const iconButton = (
    icon: IconName,
    title: string,
    onClick: (e: MouseEvent) => void,
  ) => (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "var(--vscode-editor-foreground)",
        padding: "3px 4px",
        display: "flex",
        "align-items": "center",
        "border-radius": "3px",
        opacity: "0.85",
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.opacity = "1"
        ;(e.currentTarget as HTMLElement).style.backgroundColor = "var(--vscode-toolbar-hoverBackground)"
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.opacity = "0.85"
        ;(e.currentTarget as HTMLElement).style.backgroundColor = "transparent"
      }}
    >
      <Icon name={icon} />
    </button>
  )

  return (
    <>
      {/* Main block */}
      <div
        style={{ position: "relative", margin: "8px 0" }}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <Show when={isLoading() && !svgContent()}>
          <div
            style={{
              padding: "8px 0",
              color: "var(--vscode-descriptionForeground)",
              "font-style": "italic",
              "font-size": "0.9em",
            }}
          >
            {t("ui.mermaid.loading")}
          </div>
        </Show>

        <Show when={error()}>
          {(err) => (
            <div style={{ "margin-top": "0px", overflow: "hidden", "margin-bottom": "8px" }}>
              {/* Error header */}
              <div
                style={{
                  "border-bottom": isErrorExpanded()
                    ? "1px solid var(--vscode-editorGroup-border)"
                    : "none",
                  "font-weight": "normal",
                  "font-size": "var(--vscode-font-size)",
                  color: "var(--vscode-editor-foreground)",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  cursor: "pointer",
                }}
                onClick={() => setIsErrorExpanded((v) => !v)}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "10px", "flex-grow": "1" }}>
                  <Icon name="warning" size={16} />
                  <span style={{ "font-weight": "bold" }}>
                    {isFixing() ? t("ui.mermaid.fixing") : t("ui.mermaid.renderError")}
                  </span>
                </div>
                <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
                  {iconButton("wand", t("ui.mermaid.fixSyntax"), handleApplyFixes)}
                  {iconButton(copyErrorFeedback() ? "check" : "copy", t("ui.mermaid.copyCode"), (e) => { e.stopPropagation(); handleCopyError(e) })}
                  <Icon name={isErrorExpanded() ? "chevronUp" : "chevronDown"} />
                </div>
              </div>
              {/* Error body */}
              <Show when={isErrorExpanded()}>
                <div
                  style={{
                    padding: "8px",
                    "background-color": "var(--vscode-editor-background)",
                  }}
                >
                  <div
                    style={{
                      "margin-bottom": "8px",
                      color: "var(--vscode-descriptionForeground)",
                      "font-size": "0.9em",
                      "font-family": "var(--vscode-editor-font-family)",
                      "white-space": "pre-wrap",
                      "word-break": "break-all",
                    }}
                  >
                    {err()}
                  </div>
                  <pre
                    style={{
                      margin: "0",
                      padding: "8px",
                      "background-color": "var(--vscode-textBlockQuote-background)",
                      "border-radius": "3px",
                      "font-size": "0.85em",
                      overflow: "auto",
                    }}
                  >
                    <code>{displayCode()}</code>
                  </pre>
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={!error() || svgContent()}>
          <div style={{ position: "relative" }}>
            {/* SVG container */}
            <div
              ref={svgContainerRef}
              innerHTML={svgContent()}
              onClick={handleSvgClick}
              style={{
                opacity: isLoading() ? "0.3" : "1",
                transition: "opacity 0.2s ease",
                cursor: getMermaidAPI().openImage ? "pointer" : "default",
                display: "flex",
                "justify-content": "center",
                "max-height": "400px",
                overflow: "hidden",
              }}
            />
            {/* Action bar (shown on hover) */}
            <Show when={!isLoading() && isHovering() && svgContent()}>
              <div
                style={{
                  position: "absolute",
                  bottom: "8px",
                  right: "8px",
                  display: "flex",
                  gap: "2px",
                  "background-color": "var(--vscode-editor-background)",
                  "border-radius": "4px",
                  padding: "2px",
                  "z-index": "10",
                  border: "1px solid var(--vscode-editorGroup-border)",
                }}
              >
                {iconButton("expand", t("ui.mermaid.zoom"), (e) => { e.stopPropagation(); setShowModal(true); setModalViewMode("diagram"); setZoomLevel(1); setDragPosition({ x: 0, y: 0 }) })}
                {iconButton("code", t("ui.mermaid.viewCode"), (e) => { e.stopPropagation(); setShowModal(true); setModalViewMode("code"); setZoomLevel(1) })}
                {iconButton(copyFeedback() ? "check" : "copy", t("ui.mermaid.copyDiagram"), handleCopyDiagram)}
                <Show when={getMermaidAPI().saveImage}>
                  {iconButton("save", t("ui.mermaid.save"), handleSave)}
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Modal */}
      <Show when={showModal()}>
        <div
          style={{
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            "background-color": "rgba(0,0,0,0.6)",
            "z-index": "1000",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            style={{
              "background-color": "var(--vscode-editor-background)",
              border: "1px solid var(--vscode-editorGroup-border)",
              "border-radius": "6px",
              width: "90vw",
              height: "85vh",
              display: "flex",
              "flex-direction": "column",
              overflow: "hidden",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
                "border-bottom": "1px solid var(--vscode-editorGroup-border)",
                padding: "4px 8px",
              }}
            >
              <div style={{ display: "flex", gap: "0" }}>
                {/* Diagram tab */}
                <button
                  onClick={() => setModalViewMode("diagram")}
                  style={{
                    background: modalViewMode() === "diagram" ? "var(--vscode-tab-activeBackground)" : "transparent",
                    border: "none",
                    "border-bottom": modalViewMode() === "diagram" ? "2px solid var(--vscode-focusBorder)" : "2px solid transparent",
                    color: "var(--vscode-editor-foreground)",
                    cursor: "pointer",
                    padding: "6px 12px",
                    display: "flex",
                    "align-items": "center",
                    gap: "6px",
                    "font-size": "var(--vscode-font-size)",
                  }}
                >
                  <Icon name="graph" />
                  {t("ui.mermaid.tabDiagram")}
                </button>
                {/* Code tab */}
                <button
                  onClick={() => setModalViewMode("code")}
                  style={{
                    background: modalViewMode() === "code" ? "var(--vscode-tab-activeBackground)" : "transparent",
                    border: "none",
                    "border-bottom": modalViewMode() === "code" ? "2px solid var(--vscode-focusBorder)" : "2px solid transparent",
                    color: "var(--vscode-editor-foreground)",
                    cursor: "pointer",
                    padding: "6px 12px",
                    display: "flex",
                    "align-items": "center",
                    gap: "6px",
                    "font-size": "var(--vscode-font-size)",
                  }}
                >
                  <Icon name="code" />
                  {t("ui.mermaid.tabCode")}
                </button>
              </div>
              <button
                onClick={() => setShowModal(false)}
                title={t("ui.mermaid.close")}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--vscode-editor-foreground)",
                  padding: "4px",
                  display: "flex",
                  "align-items": "center",
                }}
              >
                <Icon name="close" />
              </button>
            </div>

            {/* Modal body */}
            <div
              style={{
                flex: "1",
                overflow: "auto",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                padding: "16px",
                "padding-bottom": "60px",
              }}
              onWheel={modalViewMode() === "diagram" ? handleWheel : undefined}
            >
              <Show
                when={modalViewMode() === "diagram"}
                fallback={
                  <textarea
                    readOnly
                    value={displayCode()}
                    style={{
                      width: "100%",
                      height: "100%",
                      "min-height": "200px",
                      "background-color": "var(--vscode-editor-background)",
                      color: "var(--vscode-editor-foreground)",
                      border: "1px solid var(--vscode-editorGroup-border)",
                      "border-radius": "3px",
                      padding: "8px",
                      "font-family": "var(--vscode-editor-font-family)",
                      "font-size": "var(--vscode-editor-font-size)",
                      resize: "none",
                      outline: "none",
                    }}
                  />
                }
              >
                <div style={{ position: "relative" }}>
                  <div
                    innerHTML={svgContent()}
                    style={{
                      transform: `scale(${zoomLevel()}) translate(${dragPosition().x}px, ${dragPosition().y}px)`,
                      "transform-origin": "center center",
                      transition: isDragging() ? "none" : "transform 0.1s ease",
                      cursor: isDragging() ? "grabbing" : "grab",
                    }}
                    onMouseDown={(e) => {
                      setIsDragging(true)
                      e.preventDefault()
                    }}
                    onMouseMove={(e) => {
                      if (isDragging()) {
                        setDragPosition((prev) => ({
                          x: prev.x + e.movementX / zoomLevel(),
                          y: prev.y + e.movementY / zoomLevel(),
                        }))
                      }
                    }}
                    onMouseUp={() => setIsDragging(false)}
                    onMouseLeave={() => setIsDragging(false)}
                  />
                </div>
              </Show>
            </div>

            {/* Modal footer */}
            <div
              style={{
                position: "absolute",
                bottom: "0",
                left: "0",
                right: "0",
                padding: "8px 12px",
                display: "flex",
                "align-items": "center",
                "justify-content": "flex-end",
                gap: "4px",
                "background-color": "var(--vscode-editor-background)",
                "border-top": "1px solid var(--vscode-editorGroup-border)",
                "border-radius": "0 0 6px 6px",
              }}
            >
              <Show when={modalViewMode() === "diagram"}>
                {iconButton("minus", t("ui.mermaid.zoomOut"), () => adjustZoom(-0.2))}
                {iconButton("plus", t("ui.mermaid.zoomIn"), () => adjustZoom(0.2))}
                <span
                  style={{
                    "font-size": "12px",
                    color: "var(--vscode-descriptionForeground)",
                    "min-width": "3.5em",
                    "text-align": "center",
                    "user-select": "none",
                  }}
                >
                  {Math.round(zoomLevel() * 100)}%
                </span>
                <Show when={getMermaidAPI().saveImage}>
                  {iconButton("save", t("ui.mermaid.save"), handleSave)}
                </Show>
              </Show>
              {modalViewMode() === "diagram"
                ? iconButton(copyFeedback() ? "check" : "copy", t("ui.mermaid.copyDiagram"), handleCopyDiagram)
                : iconButton(copyFeedback() ? "check" : "copy", t("ui.mermaid.copyCode"), handleCopyCode)}
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}

/**
 * Mount a MermaidBlock Solid.js island into the given container element.
 * The container must have data-mermaid-code set (URL-encoded mermaid source).
 */
export function mountMermaidBlock(container: HTMLElement, code: string): () => void {
  return render(() => <MermaidBlock code={code} container={container} />, container)
}
