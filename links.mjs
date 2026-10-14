// Links and the clipboard, for the board pane.
//
// - findUrls: http(s) URLs in text, strictly. A link is scheme, host (letters, digits, dots
//   and hyphens; no user:password@), an optional port, then a path, query or fragment without
//   spaces, quotes, angle brackets, backticks or control characters. Trailing punctuation and
//   unbalanced closing brackets are left out, as are invisible format characters (Unicode Cf).
//   A URL followed by "…" was cut short (to fit a length or a line), so it is not a link at all.
//   Nothing else is a link: no javascript:, data:, file: or ftp:.
// - osc8: a terminal hyperlink whose visible text is the URL itself, never other text.
// - osc52: a clipboard write, which the pane sends only when the user presses c.

// The path excludes format characters (Unicode Cf, zero-width and the like): nothing invisible
// in a link. Nor "…", which marks a cut.
const URL_RE =
  /\bhttps?:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?(?:[/?#][^\s"'<>`\\\u0000-\u001f\u007f-\u009f\u2026\p{Cf}]*)?/giu
const CLOSERS = { ")": "(", "]": "[", "}": "{" }

/** Trailing punctuation, and closing brackets that the URL itself didn't open. */
function trimUrl(url) {
  let u = url
  for (;;) {
    const last = u.at(-1)
    if (/[.,;:!?*_~]/.test(last)) u = u.slice(0, -1)
    else if (CLOSERS[last] && [...u].filter((c) => c === last).length > [...u].filter((c) => c === CLOSERS[last]).length) u = u.slice(0, -1)
    else return u
  }
}

/** The http(s) URLs in `text`, in order, each as { url, index } (index into text). */
export function findUrls(text) {
  const found = []
  if (typeof text !== "string") return found
  for (const m of text.matchAll(URL_RE)) {
    if (text[m.index + m[0].length] === "\u2026") continue
    const url = trimUrl(m[0])
    // A scheme and host only, ending in a dot or a hyphen after trimming, is not a link.
    if (/^https?:\/\/[A-Za-z0-9]/i.test(url)) found.push({ url, index: m.index })
  }
  return found
}

/** A terminal hyperlink to `url` showing `url`. Only for a URL findUrls accepts whole. */
export function osc8(url) {
  const [one] = findUrls(url)
  if (!one || one.url !== url || one.index !== 0) throw new Error("not a link")
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`
}

export const MAX_COPY = 8000

/** A clipboard write of `text` (OSC 52, cut to MAX_COPY characters). */
export function osc52(text) {
  const clipped = [...(typeof text === "string" ? text : "")].slice(0, MAX_COPY).join("")
  return `\x1b]52;c;${Buffer.from(clipped, "utf8").toString("base64")}\x07`
}
