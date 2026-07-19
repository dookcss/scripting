export type AiErrorCode =
  | "not_configured"
  | "invalid_input"
  | "invalid_url"
  | "unauthorized"
  | "forbidden"
  | "model_not_found"
  | "rate_limited"
  | "content_too_large"
  | "timeout"
  | "service_unavailable"
  | "invalid_response"
  | "network"
  | "unknown"

export class AiClientError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "AiClientError"
  }
}

type AiEndpoint = "completion" | "models"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getUpstreamErrorText(payload: unknown): string {
  if (!isRecord(payload)) return ""
  const nested = isRecord(payload.error) ? payload.error : null
  const values = [
    nested?.code,
    nested?.type,
    nested?.message,
    payload.code,
    payload.message,
  ]
  return values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
}

function isContextLimitError(payload: unknown): boolean {
  const text = getUpstreamErrorText(payload)
  return [
    "context_length",
    "context window",
    "maximum context",
    "too many tokens",
    "token limit",
    "request too large",
  ].some(keyword => text.includes(keyword))
}

function isModelError(payload: unknown): boolean {
  const text = getUpstreamErrorText(payload)
  return text.includes("model") && (
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("unknown") ||
    text.includes("invalid")
  )
}

export function createHttpError(
  status: number,
  payload: unknown,
  endpoint: AiEndpoint,
): AiClientError {
  if (status === 400 && isContextLimitError(payload)) {
    return new AiClientError("content_too_large", "内容过长，已超出当前模型的上下文限制", status)
  }
  if (status === 401) {
    return new AiClientError("unauthorized", "API Key 无效、已失效或接口要求鉴权", status)
  }
  if (status === 403) {
    return new AiClientError("forbidden", "当前凭证没有访问该接口或模型的权限", status)
  }
  if (status === 404) {
    if (endpoint === "completion" && isModelError(payload)) {
      return new AiClientError("model_not_found", "配置的 AI 模型不存在或当前账号无权使用", status)
    }
    return new AiClientError("invalid_url", "AI 接口地址不正确，未找到兼容的 API 路径", status)
  }
  if (status === 408 || status === 504) {
    return new AiClientError("timeout", "AI 请求超时，请稍后重试", status)
  }
  if (status === 413) {
    return new AiClientError("content_too_large", "提交给 AI 的内容过长", status)
  }
  if (status === 429) {
    return new AiClientError("rate_limited", "AI 请求过快、余额不足或额度已用尽", status)
  }
  if (status === 500 || status === 502 || status === 503) {
    return new AiClientError("service_unavailable", "AI 服务暂时不可用，请稍后重试", status)
  }
  if (status === 400 && isModelError(payload)) {
    return new AiClientError("model_not_found", "配置的 AI 模型不存在或不可用", status)
  }
  return new AiClientError("unknown", `AI 服务拒绝了请求（HTTP ${status}）`, status)
}

export function normalizeTransportError(error: unknown): AiClientError {
  if (error instanceof AiClientError) return error

  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("aborted")
  ) {
    return new AiClientError("timeout", "AI 请求超时，请稍后重试")
  }
  return new AiClientError("network", "无法连接 AI 服务，请检查网络和接口地址")
}