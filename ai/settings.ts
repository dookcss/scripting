import { getProxySettings } from "../storage"
import { AiClientError } from "./errors"
import type { AiClientSettings, AiSettings } from "./types"

const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_AI_MODEL = "gpt-4o-mini"
const DEFAULT_AI_TARGET_LANGUAGE = "简体中文"
const DEFAULT_AI_TIMEOUT_SECONDS = 60

function clampTimeout(value: number | undefined): number {
  const timeout = Number.isFinite(value) ? Number(value) : DEFAULT_AI_TIMEOUT_SECONDS
  return Math.max(10, Math.min(180, timeout))
}

export function getAiSettings(): AiSettings {
  const stored = getProxySettings()
  const requiresApiKey = stored.aiRequiresApiKey !== false
  return {
    baseUrl: (stored.aiApiUrl || DEFAULT_AI_BASE_URL).trim(),
    apiKey: requiresApiKey ? (stored.aiApiKey || "").trim() : "",
    model: (stored.aiModel || DEFAULT_AI_MODEL).trim(),
    targetLanguage: (stored.aiTargetLang || DEFAULT_AI_TARGET_LANGUAGE).trim(),
    timeoutSeconds: clampTimeout(stored.aiTimeoutSeconds),
    requiresApiKey,
  }
}

export function isAiConfigured(settings: AiSettings = getAiSettings()): boolean {
  return Boolean(
    settings.baseUrl &&
    settings.model &&
    (!settings.requiresApiKey || settings.apiKey),
  )
}

export function getConfiguredAiSettings(): AiSettings {
  const settings = getAiSettings()
  if (!settings.baseUrl) {
    throw new AiClientError("not_configured", "请先配置 AI 接口地址")
  }
  if (!settings.model) {
    throw new AiClientError("not_configured", "请先配置 AI 模型名称")
  }
  if (settings.requiresApiKey && !settings.apiKey) {
    throw new AiClientError("not_configured", "请先配置 AI API Key，或关闭“接口需要 API Key”")
  }
  return settings
}

export function toAiClientSettings(settings: AiSettings): AiClientSettings {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    timeoutSeconds: settings.timeoutSeconds,
  }
}