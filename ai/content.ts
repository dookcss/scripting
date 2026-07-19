import type { MailMessageDetail } from "../types"
import type {
  HtmlTranslationPlan,
  HtmlTranslationSegment,
  PreparedAiContent,
} from "./types"

export const AI_CONTENT_LIMITS = {
  subject: 5000,
  summary: 12_0000,
  rewrite: 12_0000,
  translationText: 30_0000,
  translationHtmlText: 40_0000,
} as const

function decodeCodePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(value)
  } catch {
    return fallback
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    bull: "•",
    cent: "¢",
    copy: "©",
    euro: "€",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    pound: "£",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    reg: "®",
    rsquo: "’",
    trade: "™",
    yen: "¥",
  }

  return value
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => (
      decodeCodePoint(Number.parseInt(code, 16), match)
    ))
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function htmlToReadableText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  return normalizeText(decodeHtmlEntities(text).replace(/[ \t]{2,}/g, " "))
}

function findBoundary(value: string, limit: number, format: "text" | "html"): number {
  const minimum = Math.floor(limit * 0.75)
  const candidates = format === "html"
    ? [value.lastIndexOf(">", limit), value.lastIndexOf("\n", limit)]
    : [value.lastIndexOf("\n\n", limit), value.lastIndexOf("\n", limit), value.lastIndexOf("。", limit)]
  const boundary = candidates.find(index => index >= minimum)
  return boundary == null ? limit : boundary + 1
}

export function truncateContent(
  value: string,
  limit: number,
  format: "text" | "html" = "text",
): PreparedAiContent {
  const normalized = format === "text" ? normalizeText(value) : value.trim()
  if (normalized.length <= limit) {
    return { content: normalized, truncated: false }
  }

  const end = findBoundary(normalized, limit, format)
  return {
    content: normalized.slice(0, end).trim(),
    truncated: true,
  }
}

function formatAddresses(addresses: MailMessageDetail["from"]): string {
  return addresses
    .map(item => item.name ? `${item.name} <${item.address}>` : item.address)
    .join(", ")
}

export function prepareSummaryContent(mail: MailMessageDetail): PreparedAiContent {
  const body = mail.text.trim() || htmlToReadableText(mail.html)
  const source = [
    `主题：${mail.subject || "(无主题)"}`,
    `发件人：${formatAddresses(mail.from) || "(未知)"}`,
    mail.date ? `日期：${mail.date}` : "",
    "正文：",
    body,
  ].filter(Boolean).join("\n")
  return truncateContent(source, AI_CONTENT_LIMITS.summary)
}

export function prepareRewriteContent(content: string): PreparedAiContent {
  return truncateContent(content, AI_CONTENT_LIMITS.rewrite)
}

export function prepareTranslationSubject(subject: string): PreparedAiContent {
  return truncateContent(subject.replace(/[\r\n]+/g, " "), AI_CONTENT_LIMITS.subject)
}

export function prepareTranslationText(text: string): PreparedAiContent {
  return truncateContent(text, AI_CONTENT_LIMITS.translationText)
}

type HtmlStackEntry = {
  name: string
  excluded: boolean
}

const HTML_TRANSLATION_EXCLUDED_TAGS = new Set([
  "canvas",
  "code",
  "head",
  "iframe",
  "kbd",
  "math",
  "noscript",
  "object",
  "pre",
  "samp",
  "script",
  "style",
  "svg",
  "template",
  "textarea",
])

const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

function readMarkupEnd(html: string, start: number): number {
  if (html.startsWith("<!--", start)) {
    const end = html.indexOf("-->", start + 4)
    return end < 0 ? html.length : end + 3
  }
  if (html.startsWith("<![CDATA[", start)) {
    const end = html.indexOf("]]>", start + 9)
    return end < 0 ? html.length : end + 3
  }

  let quote = ""
  for (let index = start + 1; index < html.length; index++) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ">") return index + 1
  }
  return html.length
}

function isMarkupStart(html: string, index: number): boolean {
  const rest = html.slice(index)
  return (
    rest.startsWith("<!--") ||
    rest.startsWith("<![CDATA[") ||
    /^<![A-Za-z]/.test(rest) ||
    /^<\?/.test(rest) ||
    /^<\/?[A-Za-z][\w:-]*/.test(rest)
  )
}

function getTagName(markup: string): string {
  return markup.match(/^<\s*\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase() || ""
}

function hasHiddenPresentation(markup: string): boolean {
  if (/(?:\s|<)hidden(?:\s|=|\/?>)/i.test(markup)) return true
  if (/\saria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|\/?>)/i.test(markup)) return true

  const styleMatch = markup.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
  const style = styleMatch?.[1] || styleMatch?.[2] || styleMatch?.[3] || ""
  return /(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i.test(style)
}

function chooseTextChunkEnd(raw: string, start: number, maxCharacters: number): number {
  const hardEnd = Math.min(raw.length, start + maxCharacters)
  if (hardEnd >= raw.length) return raw.length

  const minimum = start + Math.floor((hardEnd - start) * 0.7)
  let end = hardEnd
  for (let index = hardEnd - 1; index >= minimum; index--) {
    if (/[\s。！？；，.!?;,]/.test(raw[index])) {
      end = index + 1
      break
    }
  }

  const ampersand = raw.lastIndexOf("&", end - 1)
  const semicolon = raw.lastIndexOf(";", end - 1)
  if (ampersand > semicolon) {
    if (ampersand > start) {
      end = ampersand
    } else {
      const entityEnd = raw.indexOf(";", end)
      if (entityEnd >= 0) end = entityEnd + 1
    }
  }

  return end > start ? end : hardEnd
}

function createTranslationSegment(
  id: number,
  raw: string,
  start: number,
  end: number,
): HtmlTranslationSegment | null {
  const leadingWhitespace = raw.match(/^\s*/)?.[0] || ""
  const trailingWhitespace = raw.match(/\s*$/)?.[0] || ""
  const coreEnd = raw.length - trailingWhitespace.length
  const core = raw.slice(leadingWhitespace.length, coreEnd)
  const text = decodeHtmlEntities(core).trim()
  if (!text) return null

  return {
    id,
    start,
    end,
    leadingWhitespace,
    trailingWhitespace,
    text,
  }
}

export function prepareTranslationHtml(html: string): HtmlTranslationPlan {
  const segments: HtmlTranslationSegment[] = []
  const stack: HtmlStackEntry[] = []
  let translatedCharacterCount = 0
  let truncated = false
  let cursor = 0

  const appendText = (start: number, end: number) => {
    if (stack[stack.length - 1]?.excluded) return

    const raw = html.slice(start, end)
    if (!decodeHtmlEntities(raw).trim()) return

    let offset = 0
    while (offset < raw.length) {
      const remaining = AI_CONTENT_LIMITS.translationHtmlText - translatedCharacterCount
      if (remaining <= 0) {
        truncated = true
        return
      }

      const chunkEnd = chooseTextChunkEnd(raw, offset, remaining)
      const chunk = raw.slice(offset, chunkEnd)
      const segment = createTranslationSegment(
        segments.length,
        chunk,
        start + offset,
        start + chunkEnd,
      )

      if (segment) {
        if (segment.text.length > remaining) {
          truncated = true
          return
        }
        segments.push(segment)
        translatedCharacterCount += segment.text.length
      }
      offset = chunkEnd
    }
  }

  while (cursor < html.length) {
    if (html[cursor] !== "<" || !isMarkupStart(html, cursor)) {
      const nextMarkup = html.indexOf("<", cursor + 1)
      const end = nextMarkup < 0 ? html.length : nextMarkup
      appendText(cursor, end)
      cursor = end
      continue
    }

    const end = readMarkupEnd(html, cursor)
    const markup = html.slice(cursor, end)
    const tagName = getTagName(markup)

    if (tagName) {
      if (/^<\s*\//.test(markup)) {
        for (let index = stack.length - 1; index >= 0; index--) {
          if (stack[index].name === tagName) {
            stack.length = index
            break
          }
        }
      } else {
        const parentExcluded = stack[stack.length - 1]?.excluded || false
        const excluded = (
          parentExcluded ||
          HTML_TRANSLATION_EXCLUDED_TAGS.has(tagName) ||
          hasHiddenPresentation(markup)
        )
        const selfClosing = /\/\s*>$/.test(markup) || HTML_VOID_TAGS.has(tagName)
        if (!selfClosing) stack.push({ name: tagName, excluded })
      }
    }

    cursor = end
  }

  const requestContent = JSON.stringify(
    segments.map(segment => ({ id: segment.id, text: segment.text })),
  )

  return { html, segments, requestContent, truncated }
}

function cleanJsonEnvelope(value: string): string {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return (fenced?.[1] ?? trimmed).trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function applyTranslatedHtml(
  plan: HtmlTranslationPlan,
  response: string,
): string | null {
  let payload: unknown
  try {
    payload = JSON.parse(cleanJsonEnvelope(response))
  } catch {
    return null
  }

  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.translations)
      ? payload.translations
      : null
  if (!items) return null

  const expectedIds = new Set(plan.segments.map(segment => segment.id))
  const translations = new Map<number, string>()
  for (const item of items) {
    if (!isRecord(item) || !Number.isInteger(item.id) || typeof item.text !== "string") {
      return null
    }
    const id = item.id as number
    if (!expectedIds.has(id) || translations.has(id)) return null
    translations.set(id, item.text)
  }
  if (translations.size !== expectedIds.size) return null

  let result = plan.html
  const descending = plan.segments.slice().sort((left, right) => right.start - left.start)
  for (const segment of descending) {
    const translated = translations.get(segment.id)?.trim()
    if (!translated) return null
    const replacement = (
      segment.leadingWhitespace +
      escapeHtmlText(translated) +
      segment.trailingWhitespace
    )
    result = result.slice(0, segment.start) + replacement + result.slice(segment.end)
  }
  return result
}

export function cleanTextResult(value: string): string {
  return value.trim()
}

export function cleanTranslatedSubject(value: string): string {
  return value
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim()
}
