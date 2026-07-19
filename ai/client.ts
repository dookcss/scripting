import { AiClientError, createHttpError, normalizeTransportError } from "./errors"
import type { AiClient, AiClientSettings, AiCompletionInput } from "./types"

type AiFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
  debugLabel?: string
  allowInsecureRequest?: boolean
}

type AiFetchResponse = {
  ok: boolean
  status: number
  text: () => Promise<string>
}

declare const fetch: (input: string, init?: AiFetchInit) => Promise<AiFetchResponse>

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "")
  if (!normalized) {
    throw new AiClientError("invalid_url", "AI 接口地址不能为空")
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new AiClientError("invalid_url", "AI 接口地址格式不正确")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AiClientError("invalid_url", "AI 接口地址必须以 http:// 或 https:// 开头")
  }

  const path = url.pathname.replace(/\/+$/, "").toLowerCase()
  if (path.endsWith("/chat/completions") || path.endsWith("/models")) {
    throw new AiClientError("invalid_url", "请填写 AI 基础地址，不要包含 /chat/completions 或 /models")
  }

  return normalized
}

function clampTimeout(value: number): number {
  return Math.max(5, Math.min(300, value))
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function requestJson(
  url: string,
  init: AiFetchInit,
  endpoint: "completion" | "models",
): Promise<unknown> {
  try {
    const response = await fetch(url, init)
    const text = await response.text()
    const payload = parseJson(text)

    if (!response.ok) {
      throw createHttpError(response.status, payload, endpoint)
    }
    if (payload == null) {
      throw new AiClientError("invalid_response", "AI 服务返回了无法解析的响应", response.status)
    }
    return payload
  } catch (error: unknown) {
    throw normalizeTransportError(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function extractContentPart(value: unknown): string {
  if (typeof value === "string") return value
  if (!isRecord(value)) return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  return ""
}

function extractCompletionText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new AiClientError("invalid_response", "AI 响应缺少 choices 字段")
  }

  const firstChoice = payload.choices[0]
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new AiClientError("invalid_response", "AI 响应缺少消息内容")
  }

  const content = firstChoice.message.content
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map(extractContentPart).join("")
      : ""

  const result = text.trim()
  if (!result) {
    throw new AiClientError("invalid_response", "AI 服务返回了空内容")
  }
  return result
}

function extractModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new AiClientError("invalid_response", "模型列表响应缺少 data 字段")
  }

  const ids = payload.data
    .map(item => isRecord(item) && typeof item.id === "string" ? item.id.trim() : "")
    .filter(Boolean)

  const unique = Array.from(new Set(ids))
  unique.sort((left, right) => left.localeCompare(right))
  if (unique.length === 0) {
    throw new AiClientError("invalid_response", "接口未返回任何有效模型")
  }
  return unique
}

export function createAiClient(settings: AiClientSettings): AiClient {
  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  const headers = buildHeaders(settings.apiKey.trim())
  const defaultTimeout = clampTimeout(settings.timeoutSeconds || 60)
  const allowInsecureRequest = baseUrl.startsWith("http://")

  return {
    async completeText(input: AiCompletionInput): Promise<string> {
      if (!settings.model.trim()) {
        throw new AiClientError("not_configured", "请先配置 AI 模型名称")
      }
      if (!input.messages.length) {
        throw new AiClientError("invalid_input", "AI 请求消息不能为空")
      }

      const body: Record<string, unknown> = {
        model: settings.model.trim(),
        messages: input.messages,
        temperature: input.temperature ?? 0.3,
      }
      if (input.maxOutputTokens != null) {
        body.max_tokens = input.maxOutputTokens
      }

      const payload = await requestJson(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          timeout: clampTimeout(input.timeoutSeconds ?? defaultTimeout),
          debugLabel: input.debugLabel || "ai-chat-completions",
          allowInsecureRequest,
        },
        "completion",
      )
      return extractCompletionText(payload)
    },

    async listModels(timeoutSeconds?: number): Promise<string[]> {
      const payload = await requestJson(
        `${baseUrl}/models`,
        {
          method: "GET",
          headers,
          timeout: clampTimeout(timeoutSeconds ?? Math.min(defaultTimeout, 30)),
          debugLabel: "ai-models",
          allowInsecureRequest,
        },
        "models",
      )
      return extractModelIds(payload)
    },
  }
}