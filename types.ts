/** 代理策略：auto 按预设；proxy 强制经 Worker；direct 强制直连 */
export type ProxyMode = "auto" | "proxy" | "direct"

export type AuthType = "password" | "oauth2"

export type EmailProviderId =
  | "gmail"
  | "outlook"
  | "icloud"
  | "qq"
  | "163"
  | "custom"

export type EmailAccount = {
  id: string
  name: string
  email: string
  providerId: EmailProviderId
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  /** starttls：连接后 STARTTLS（如 587） */
  smtpStartTLS: boolean
  username: string
  /** 是否使用 Worker 中转；null 表示跟随全局 auto 策略 */
  useProxy: boolean | null
  createdAt: number
  updatedAt: number
}

export type ProxySettings = {
  /** Worker 根地址，如 https://mail.example.com */
  workerUrl: string
  /** 对应 Worker AUTH_TOKEN */
  authToken: string
  /** 全局默认策略 */
  mode: ProxyMode
  /** 请求超时秒数 */
  timeoutSeconds: number
  /** 本地中转服务地址，如 http://192.168.1.100:18000 */
  localUrl?: string
  /** 本地中转服务授权令牌 */
  localToken?: string
  /** AI API 的的基础 URL 地址 */
  aiApiUrl?: string
  /** AI API 的 API Key */
  aiApiKey?: string
  /** AI 使用的模型名称 */
  aiModel?: string
  /** AI 翻译的目标语言 */
  aiTargetLang?: string
  /** AI 请求超时秒数 */
  aiTimeoutSeconds?: number
  /** AI 接口是否要求 API Key；关闭后允许本地无鉴权接口 */
  aiRequiresApiKey?: boolean
}

export type MailAddress = {
  name?: string
  address: string
}

export type MailMessageSummary = {
  uid: number
  seq: number
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  date: string
  seen: boolean
  flagged: boolean
  hasAttachment: boolean
  snippet: string
  size: number
}

export type MailMessageDetail = MailMessageSummary & {
  cc: MailAddress[]
  bcc: MailAddress[]
  replyTo: MailAddress[]
  text: string
  html: string
  messageId: string
  inReplyTo: string
  references: string
  attachments?: {
    filename: string
    content: string // Base64
    mimeType?: string
    size?: number
  }[]
}

export type MailFolder = {
  name: string
  delimiter: string
  flags: string[]
}

export type SendMailInput = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string
  inReplyTo?: string
  references?: string
  attachments?: {
    filename: string
    content: string // Base64
    mimeType?: string
  }[]
}

export type MailAction =
  | { type: "markSeen"; uids: number[]; seen: boolean }
  | { type: "flag"; uids: number[]; flagged: boolean }
  | { type: "delete"; uids: number[] }
  | { type: "move"; uids: number[]; folder: string }

export type ListMessagesInput = {
  folder?: string
  page?: number
  pageSize?: number
  unseenOnly?: boolean
  keyword?: string
}

export type ListMessagesResult = {
  folder: string
  total: number
  page: number
  pageSize: number
  messages: MailMessageSummary[]
}

export type ConnectionProfile = {
  email: string
  username: string
  password: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpStartTLS: boolean
}

export type ApiOk<T> = { ok: true; data: T }
export type ApiErr = { ok: false; error: string; code?: string }
export type ApiResult<T> = ApiOk<T> | ApiErr

export type ProviderPreset = {
  id: EmailProviderId
  name: string
  domainHints: string[]
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpStartTLS: boolean
  /** auto 模式下是否默认走代理 */
  preferProxy: boolean
  hint: string
}
