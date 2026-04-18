/**
 * VS Code API context provider
 * Provides access to the VS Code webview API for posting messages
 */

import { createContext, useContext, onCleanup, ParentComponent } from "solid-js"
import type { VSCodeAPI, WebviewMessage, ExtensionMessage } from "../types/messages"
import { configureMermaid } from "@opencode-ai/ui/mermaid" // kilocode_change

// Get the VS Code API (only available in webview context)
let vscodeApi: VSCodeAPI | undefined

export function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    // In VS Code webview, acquireVsCodeApi is available globally
    if (typeof acquireVsCodeApi === "function") {
      vscodeApi = acquireVsCodeApi()
    } else {
      // Mock for development/testing outside VS Code
      console.warn("[Kilo New] Running outside VS Code, using mock API")
      vscodeApi = {
        postMessage: (msg) => console.log("[Kilo New] Mock postMessage:", msg),
        getState: () => undefined,
        setState: () => {},
      }
    }
  }
  return vscodeApi
}

// Context value type
interface VSCodeContextValue {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
  getState: <T>() => T | undefined
  setState: <T>(state: T) => void
}

const VSCodeContext = createContext<VSCodeContextValue>()

export const VSCodeProvider: ParentComponent = (props) => {
  const api = getVSCodeAPI()
  const handlers = new Set<(message: ExtensionMessage) => void>()

  // kilocode_change: register mermaid AI fix using the existing enhancePrompt
  // endpoint (already in the binary) — no new backend route required.
  configureMermaid({
    fixSyntax: (code, error) =>
      new Promise((resolve, reject) => {
        const requestId = `mermaid-fix-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
        const text =
          `Fix the following invalid Mermaid diagram and return ONLY the corrected Mermaid code ` +
          `without any explanation or markdown formatting.\n\nError: ${error}\n\nCode:\n${code}`
        let timeout: ReturnType<typeof setTimeout>
        const listener = (event: MessageEvent) => {
          const msg = event.data
          if (msg?.requestId !== requestId) return
          clearTimeout(timeout)
          window.removeEventListener("message", listener)
          if (msg.type === "enhancePromptResult" && msg.text) resolve(msg.text as string)
          else reject(new Error((msg.error as string | undefined) || "Failed to fix Mermaid syntax"))
        }
        timeout = setTimeout(() => {
          window.removeEventListener("message", listener)
          reject(new Error("Mermaid fix timed out"))
        }, 30000)
        window.addEventListener("message", listener)
        api.postMessage({ type: "enhancePrompt", text, requestId } as WebviewMessage)
      }),
  })

  // Listen for messages from the extension
  const messageListener = (event: MessageEvent) => {
    const message = event.data as ExtensionMessage
    handlers.forEach((handler) => handler(message))
  }

  window.addEventListener("message", messageListener)

  onCleanup(() => {
    window.removeEventListener("message", messageListener)
    handlers.clear()
  })

  const value: VSCodeContextValue = {
    postMessage: (message: WebviewMessage) => {
      api.postMessage(message)
    },
    onMessage: (handler: (message: ExtensionMessage) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    getState: <T,>() => api.getState() as T | undefined,
    setState: <T,>(state: T) => api.setState(state),
  }

  return <VSCodeContext.Provider value={value}>{props.children}</VSCodeContext.Provider>
}

export function useVSCode(): VSCodeContextValue {
  const context = useContext(VSCodeContext)
  if (!context) {
    throw new Error("useVSCode must be used within a VSCodeProvider")
  }
  return context
}
