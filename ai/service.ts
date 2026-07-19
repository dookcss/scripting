import type { MailMessageDetail } from "../types"
import { createAiClient } from "./client"
import {
  applyTranslatedHtml,
  cleanTextResult,
  cleanTranslatedSubject,
  prepareRewriteContent,
  prepareSummaryContent,
  prepareTranslationHtml,
  prepareTranslationSubject,
  prepareTranslationText,
} from "./content"
import { AiClientError } from "./errors"
import {
  DRAFT_REWRITE_PROMPTS,
  MAIL_SUMMARY_PROMPT,
  createTranslationPrompt,
} from "./prompts"
import {
  getAiSettings,
  getConfiguredAiSettings,
  isAiConfigured as isStoredAiConfigured,
  toAiClientSettings,
} from "./settings"
import type {
  AiTextResult,
  DraftRewriteMode,
  ListAvailableModelsInput,
  MailTranslationField,
  MailTranslationResult,
} from "./types"

function operationTimeout(configured: number, minimum: number): number {
  return Math.max(configured, minimum)
}

export function isAiConfigured(): boolean {
  return isStoredAiConfigured(getAiSettings())
}

export async function summarizeMail(mail: MailMessageDetail): Promise<AiTextResult> {
  const settings = getConfiguredAiSettings()
  const prepared = prepareSummaryContent(mail)
  if (!prepared.content) {
    throw new AiClientError("invalid_input", "邮件没有可供总结的正文内容")
  }

  const client = createAiClient(toAiClientSettings(settings))
  const text = await client.completeText({
    messages: [
      { role: "system", content: MAIL_SUMMARY_PROMPT },
      { role: "user", content: prepared.content },
    ],
    temperature: 0.25,
    timeoutSeconds: operationTimeout(settings.timeoutSeconds, 60),
    debugLabel: "ai-mail-summary",
  })

  return {
    text: cleanTextResult(text),
    truncated: prepared.truncated,
  }
}

export async function translateMail(
  mail: MailMessageDetail,
  targetLanguage?: string,
): Promise<MailTranslationResult> {
  const settings = getConfiguredAiSettings()
  const target = (targetLanguage || settings.targetLanguage).trim() || "简体中文"
  const subject = prepareTranslationSubject(mail.subject || "")
  const html = mail.html ? prepareTranslationHtml(mail.html) : null
  const text = mail.text ? prepareTranslationText(mail.text) : null

  if (!subject.content && !html?.segments.length && !text?.content) {
    throw new AiClientError("invalid_input", "邮件没有可供翻译的内容")
  }

  const client = createAiClient(toAiClientSettings(settings))
  const timeoutSeconds = operationTimeout(settings.timeoutSeconds, 90)

  const subjectTask = subject.content
    ? client.completeText({
        messages: [
          { role: "system", content: createTranslationPrompt(target, "subject") },
          { role: "user", content: subject.content },
        ],
        temperature: 0.2,
        timeoutSeconds,
        debugLabel: "ai-mail-subject-translation",
      })
    : Promise.resolve("")

  const htmlTask = html?.segments.length
    ? client.completeText({
        messages: [
          { role: "system", content: createTranslationPrompt(target, "htmlSegments") },
          { role: "user", content: html.requestContent },
        ],
        temperature: 0.1,
        timeoutSeconds,
        debugLabel: "ai-mail-html-text-translation",
      })
    : Promise.resolve("")

  const textTask = text?.content
    ? client.completeText({
        messages: [
          { role: "system", content: createTranslationPrompt(target, "text") },
          { role: "user", content: text.content },
        ],
        temperature: 0.2,
        timeoutSeconds,
        debugLabel: "ai-mail-text-translation",
      })
    : Promise.resolve("")

  const [subjectResult, htmlResult, textResult] = await Promise.all([
    subjectTask,
    htmlTask,
    textTask,
  ])

  const translatedHtml = html
    ? html.segments.length === 0
      ? html.html
      : applyTranslatedHtml(html, htmlResult)
    : undefined
  if (html?.segments.length && !translatedHtml) {
    throw new AiClientError(
      "invalid_response",
      "AI 返回的 HTML 文本翻译格式不完整，已取消回填以保护原邮件结构",
    )
  }

  const truncatedFields: MailTranslationField[] = []
  if (subject.truncated) truncatedFields.push("subject")
  if (html?.truncated) truncatedFields.push("html")
  if (text?.truncated) truncatedFields.push("text")

  return {
    subject: subjectResult ? cleanTranslatedSubject(subjectResult) : mail.subject,
    html: translatedHtml || undefined,
    text: textResult ? cleanTextResult(textResult) : undefined,
    truncated: truncatedFields.length > 0,
    truncatedFields,
  }
}

export async function rewriteDraft(
  content: string,
  mode: DraftRewriteMode,
): Promise<AiTextResult> {
  const settings = getConfiguredAiSettings()
  const prepared = prepareRewriteContent(content)
  if (!prepared.content && mode !== "continue") {
    throw new AiClientError("invalid_input", "请先输入需要处理的邮件正文")
  }

  const client = createAiClient(toAiClientSettings(settings))
  const source = prepared.content || "当前正文为空，请从合适的邮件开头开始撰写。"
  const result = await client.completeText({
    messages: [
      { role: "system", content: DRAFT_REWRITE_PROMPTS[mode] },
      { role: "user", content: source },
    ],
    temperature: 0.35,
    timeoutSeconds: operationTimeout(settings.timeoutSeconds, 45),
    debugLabel: `ai-draft-${mode}`,
  })

  return {
    text: cleanTextResult(result),
    truncated: prepared.truncated,
  }
}

export async function listAvailableModels(
  input: ListAvailableModelsInput,
): Promise<string[]> {
  const baseUrl = input.baseUrl.trim()
  const apiKey = (input.apiKey || "").trim()
  const requiresApiKey = input.requiresApiKey !== false
  if (!baseUrl) {
    throw new AiClientError("not_configured", "请先填写 AI 接口地址")
  }
  if (requiresApiKey && !apiKey) {
    throw new AiClientError("not_configured", "请先填写 API Key，或关闭“接口需要 API Key”")
  }

  const client = createAiClient({
    baseUrl,
    apiKey: requiresApiKey ? apiKey : "",
    model: (input.model || "model-list").trim(),
    timeoutSeconds: Math.max(10, Math.min(60, input.timeoutSeconds || 30)),
  })
  return client.listModels()
}