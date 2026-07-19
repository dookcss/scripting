import { getAccountPassword, getProxySettings, shouldUseProxy } from "./storage"
import type {
  ApiResult,
  ConnectionProfile,
  EmailAccount,
  ListMessagesInput,
  ListMessagesResult,
  MailAction,
  MailFolder,
  MailMessageDetail,
  SendMailInput,
} from "./types"

declare const fetch: any;

function buildProfile(account: EmailAccount, password?: string): ConnectionProfile {
  const pwd = password ?? getAccountPassword(account.id)
  return {
    email: account.email,
    username: account.username || account.email,
    password: pwd,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapSecure: account.imapSecure,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    smtpStartTLS: account.smtpStartTLS,
  }
}

function ensureProxyReady(account: EmailAccount): string | null {
  const proxy = getProxySettings()
  const useWorker = shouldUseProxy(account)

  if (useWorker) {
    if (!proxy.workerUrl) {
      return "尚未配置 Worker 地址。请先到「代理设置」填写你的 Cloudflare Worker URL。"
    }
    if (!proxy.authToken) {
      return "尚未配置访问令牌。请填写与 Worker AUTH_TOKEN 一致的令牌。"
    }
  } else {
    // 直连本地中继
    if (!proxy.localUrl) {
      return "当前邮箱为直连模式，但尚未配置「本地服务地址」。请先到「代理设置」填写本地 Node 服务 IP（如 http://192.168.1.100:18000）。"
    }
  }
  return null
}

async function callWorker<T>(
  account: EmailAccount,
  path: string,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  const proxy = getProxySettings()
  const useWorker = shouldUseProxy(account)

  const baseUrl = useWorker ? proxy.workerUrl : (proxy.localUrl || "http://localhost:18000")
  const token = useWorker ? proxy.authToken : (proxy.localToken || "local_dev_token")
  const label = useWorker ? `mail-proxy ${path}` : `mail-local-relay ${path}`

  const url = `${baseUrl.replace(/\/+$/, "")}${path}`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      timeout: proxy.timeoutSeconds,
      debugLabel: label,
    })

    const text = await response.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      return {
        ok: false,
        error: `中继服务返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
        code: "bad_response",
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        error: json?.error || `中继服务请求失败 HTTP ${response.status}`,
        code: json?.code || `http_${response.status}`,
      }
    }

    if (json?.ok === false) {
      return {
        ok: false,
        error: json.error || "中继服务业务错误",
        code: json.code,
      }
    }

    return {
      ok: true,
      data: (json?.data ?? json) as T,
    }
  } catch (error: any) {
    const message = error?.message || String(error)
    if (message.includes("timed out") || message.includes("Timeout")) {
      return { ok: false, error: "请求超时，请检查中继服务是否可访问、网络是否正常", code: "timeout" }
    }
    return { ok: false, error: `网络错误：${message}`, code: "network" }
  }
}

function withAccountBody(account: EmailAccount, extra: Record<string, unknown> = {}, password?: string) {
  return {
    connection: buildProfile(account, password),
    ...extra,
  }
}

export async function testAccountConnection(
  account: EmailAccount,
  password?: string,
): Promise<ApiResult<{ folder: string; exists: number }>> {
  const readyError = ensureProxyReady(account)
  if (readyError) return { ok: false, error: readyError, code: "proxy_not_ready" }

  const profile = buildProfile(account, password)
  if (!profile.password) {
    return { ok: false, error: "请先填写邮箱密码 / 应用专用密码", code: "no_password" }
  }

  return callWorker(account, "/v1/test", { connection: profile })
}

export async function listFolders(account: EmailAccount): Promise<ApiResult<MailFolder[]>> {
  const readyError = ensureProxyReady(account)
  if (readyError) return { ok: false, error: readyError, code: "proxy_not_ready" }
  return callWorker(account, "/v1/folders", withAccountBody(account))
}

export async function listMessages(
  account: EmailAccount,
  input: ListMessagesInput = {},
): Promise<ApiResult<ListMessagesResult>> {
  const readyError = ensureProxyReady(account)
  if (readyError) return { ok: false, error: readyError, code: "proxy_not_ready" }

  return callWorker(account, "/v1/messages", withAccountBody(account, {
    folder: input.folder || "INBOX",
    page: input.page || 1,
    pageSize: input.pageSize || 30,
    unseenOnly: !!input.unseenOnly,
    keyword: input.keyword,
  }))
}

export async function getMessage(
  account: EmailAccount,
  uid: number,
  folder = "INBOX",
): Promise<ApiResult<MailMessageDetail>> {
  const readyError = ensureProxyReady(account)
  if (readyError) return { ok: false, error: readyError, code: "proxy_not_ready" }

  return callWorker(account, "/v1/message", withAccountBody(account, { folder, uid }))
}

export async function sendMail(
  account: EmailAccount,
  mail: SendMailInput,
): Promise<ApiResult<{ messageId: string }>> {
  const readyError = ensureProxyReady(account)
  if (readyError) return { ok: false, error: readyError, code: "proxy_not_ready" }

  if (!mail.to?.length) {
    return { ok: false, error: "请至少填写一个收件人", code: "validation" }
  }
  if (!mail.subject?.trim()) {
    return { ok: false, error: "请填写邮件主题", code: "validation" }
  }
  if (!mail.text?.trim() && !mail.html?.trim()) {
    return { ok: false, error: "请填写邮件正文", code: "validation" }
  }

  return callWorker(account, "/v1/send", withAccountBody(account, { mail }))
}

export async function applyMailAction(
  account: EmailAccount,
  action: MailAction,
  folder = "INBOX",
): Promise<ApiResult<{ updated: number }>> {
  const readyError = ensureProxyReady(account)
  if (readyError) return { ok: false, error: readyError, code: "proxy_not_ready" }

  return callWorker(account, "/v1/action", withAccountBody(account, { folder, action }))
}

export function formatAddresses(
  list: { name?: string; address: string }[] | undefined,
): string {
  if (!list?.length) return ""
  return list
    .map(item => (item.name ? `${item.name} <${item.address}>` : item.address))
    .join(", ")
}

export function formatDateLabel(value: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const sameYear = date.getFullYear() === now.getFullYear()
  if (sameYear) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
