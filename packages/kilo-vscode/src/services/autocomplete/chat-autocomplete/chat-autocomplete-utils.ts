/**
 * Strip prefix echo from a FIM response.
 *
 * Some FIM endpoints echo back part (or all) of the prompt before
 * producing new content.  This finds the longest suffix of `prefix`
 * that matches a prefix of `response` and removes it so only the
 * genuinely new completion text remains.
 */
const MIN_ECHO_LEN = 8

export function stripPrefixEcho(response: string, prefix: string): string {
  if (!response || !prefix) return response

  // Fast path: full echo
  if (response.startsWith(prefix)) return response.slice(prefix.length)

  // Find the longest suffix of prefix that matches the start of response.
  // Requires at least MIN_ECHO_LEN characters to avoid false positives on
  // trivially short overlaps (e.g. a single space or common word).
  const limit = Math.min(prefix.length, response.length)
  for (let len = limit; len >= MIN_ECHO_LEN; len--) {
    const tail = prefix.slice(-len)
    if (response.startsWith(tail)) return response.slice(len)
  }

  return response
}

/**
 * Apply chat-specific post-processing to a suggestion:
 * - Filter suggestions that look like code comments
 * - Truncate at first newline (chat is single-line)
 * - Trim trailing whitespace
 * Returns empty string when the suggestion should be discarded.
 */
export function finalizeChatSuggestion(cleaned: string): string {
  if (!cleaned) return ""

  if (cleaned.match(/^(\/\/|\/\*|\*|#)/)) {
    return ""
  }

  const firstNewline = cleaned.indexOf("\n")
  const truncated = firstNewline !== -1 ? cleaned.substring(0, firstNewline) : cleaned
  return truncated.trimEnd()
}

/**
 * Build the prefix string for a chat completion request from user text and visible code context.
 */
export function buildChatPrefix(
  userText: string,
  editors?: Array<{
    filePath: string
    languageId: string
    visibleRanges: Array<{ content: string }>
  }>,
): string {
  const parts: string[] = []
  if (editors && editors.length > 0) {
    parts.push("// Code visible in editor:")
    for (const editor of editors) {
      const fileName = editor.filePath.split("/").pop() || editor.filePath
      parts.push(`\n// File: ${fileName} (${editor.languageId})`)
      for (const range of editor.visibleRanges) {
        parts.push(range.content)
      }
    }
  }
  parts.push("\n// User's message:")
  parts.push(userText)
  return parts.join("\n")
}
