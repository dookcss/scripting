export type AiMessageRole = "system" | "user" | "assistant"

export type AiMessage = {
  role: AiMessageRole
  content: string
}

export type AiClientSettings = {
  baseUrl: string
  apiKey: string
  model: string
  timeoutSeconds: number
}

export type AiSettings = AiClientSettings & {
  targetLanguage: string
  requiresApiKey: boolean
}

export type AiCompletionInput = {
  messages: AiMessage[]
  temperature?: number
  maxOutputTokens?: number
  timeoutSeconds?: number
  debugLabel?: string
}

export type AiClient = {
  completeText: (input: AiCompletionInput) => Promise<string>
  listModels: (timeoutSeconds?: number) => Promise<string[]>
}

export type DraftRewriteMode =
  | "polish"
  | "continue"
  | "format"
  | "shorten"

export type AiTextResult = {
  text: string
  truncated: boolean
}

export type MailTranslationField = "subject" | "text" | "html"

export type MailTranslationResult = {
  subject: string
  text?: string
  html?: string
  truncated: boolean
  truncatedFields: MailTranslationField[]
}

export type ListAvailableModelsInput = {
  baseUrl: string
  apiKey?: string
  model?: string
  timeoutSeconds?: number
  requiresApiKey?: boolean
}

export type PreparedAiContent = {
  content: string
  truncated: boolean
}

export type HtmlTranslationSegment = {
  id: number
  start: number
  end: number
  leadingWhitespace: string
  trailingWhitespace: string
  text: string
}

export type HtmlTranslationPlan = {
  html: string
  segments: HtmlTranslationSegment[]
  requestContent: string
  truncated: boolean
}