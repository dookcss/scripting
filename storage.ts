import type { EmailAccount, ProxySettings } from "./types"
import { getPreset } from "./presets"

const ACCOUNTS_KEY = "email_accounts_v1"
const ACTIVE_ACCOUNT_KEY = "email_active_account_v1"
const PROXY_KEY = "email_proxy_settings_v1"
const passwordKey = (accountId: string) => `email_pwd_${accountId}`
const DEFAULT_PROXY: ProxySettings = {
  workerUrl: "",
  authToken: "",
  mode: "auto",
  timeoutSeconds: 45,
  localUrl: "",
  localToken: "local_dev_token",
  aiApiUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiTargetLang: "简体中文",
  aiTimeoutSeconds: 60,
  aiRequiresApiKey: true,
}

function createId(): string {
  return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function getProxySettings(): ProxySettings {
  const stored = Storage.get<ProxySettings>(PROXY_KEY)
  return {
    ...DEFAULT_PROXY,
    ...(stored ?? {}),
  }
}

export function saveProxySettings(settings: ProxySettings): void {
  Storage.set(PROXY_KEY, {
    workerUrl: settings.workerUrl.trim().replace(/\/+$/, ""),
    authToken: settings.authToken.trim(),
    mode: settings.mode,
    timeoutSeconds: Math.max(10, Math.min(120, settings.timeoutSeconds || 45)),
    localUrl: (settings.localUrl || "").trim().replace(/\/+$/, ""),
    localToken: (settings.localToken || "").trim(),
    aiApiUrl: (settings.aiApiUrl || "").trim(),
    aiApiKey: (settings.aiApiKey || "").trim(),
    aiModel: (settings.aiModel || "").trim(),
    aiTargetLang: (settings.aiTargetLang || "").trim(),
    aiTimeoutSeconds: Math.max(10, Math.min(180, settings.aiTimeoutSeconds || 60)),
    aiRequiresApiKey: settings.aiRequiresApiKey !== false,
  })
}

export function listAccounts(): EmailAccount[] {
  const accounts = Storage.get<EmailAccount[]>(ACCOUNTS_KEY) ?? []
  return accounts.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getAccount(accountId: string): EmailAccount | null {
  return listAccounts().find(item => item.id === accountId) ?? null
}

export function getActiveAccountId(): string | null {
  return Storage.get<string>(ACTIVE_ACCOUNT_KEY)
}

export function setActiveAccountId(accountId: string | null): void {
  if (accountId == null) {
    Storage.remove(ACTIVE_ACCOUNT_KEY)
    return
  }
  Storage.set(ACTIVE_ACCOUNT_KEY, accountId)
}

export function getActiveAccount(): EmailAccount | null {
  const accounts = listAccounts()
  if (accounts.length === 0) return null

  const activeId = getActiveAccountId()
  if (activeId) {
    const found = accounts.find(item => item.id === activeId)
    if (found) return found
  }
  return accounts[0]
}

export function getAccountPassword(accountId: string): string {
  return Keychain.get(passwordKey(accountId)) ?? ""
}

export function saveAccountPassword(accountId: string, password: string): void {
  if (!password) {
    Keychain.remove(passwordKey(accountId))
    return
  }
  Keychain.set(passwordKey(accountId), password, {
    accessibility: "first_unlock_this_device",
  })
}

export function upsertAccount(
  input: Omit<EmailAccount, "id" | "createdAt" | "updatedAt"> & {
    id?: string
    password?: string
  },
): EmailAccount {
  const accounts = listAccounts()
  const now = Date.now()
  const existingIndex = input.id
    ? accounts.findIndex(item => item.id === input.id)
    : -1

  let account: EmailAccount
  if (existingIndex >= 0) {
    const previous = accounts[existingIndex]
    account = {
      ...previous,
      name: input.name.trim() || input.email.trim(),
      email: input.email.trim(),
      providerId: input.providerId,
      imapHost: input.imapHost.trim(),
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      smtpHost: input.smtpHost.trim(),
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      smtpStartTLS: input.smtpStartTLS,
      username: (input.username || input.email).trim(),
      useProxy: input.useProxy,
      updatedAt: now,
    }
    accounts[existingIndex] = account
  } else {
    account = {
      id: input.id || createId(),
      name: input.name.trim() || input.email.trim(),
      email: input.email.trim(),
      providerId: input.providerId,
      imapHost: input.imapHost.trim(),
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      smtpHost: input.smtpHost.trim(),
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      smtpStartTLS: input.smtpStartTLS,
      username: (input.username || input.email).trim(),
      useProxy: input.useProxy,
      createdAt: now,
      updatedAt: now,
    }
    accounts.push(account)
  }

  Storage.set(ACCOUNTS_KEY, accounts)

  if (input.password != null && input.password !== "") {
    saveAccountPassword(account.id, input.password)
  }

  if (!getActiveAccountId()) {
    setActiveAccountId(account.id)
  }

  return account
}

export function deleteAccount(accountId: string): void {
  const next = listAccounts().filter(item => item.id !== accountId)
  Storage.set(ACCOUNTS_KEY, next)
  Keychain.remove(passwordKey(accountId))

  if (getActiveAccountId() === accountId) {
    setActiveAccountId(next[0]?.id ?? null)
  }
}

export function shouldUseProxy(account: EmailAccount): boolean {
  if (account.useProxy === true) return true
  if (account.useProxy === false) return false

  const proxy = getProxySettings()
  if (proxy.mode === "proxy") return true
  if (proxy.mode === "direct") return false

  // auto：默认读取预设（目前直连未实现，预设均已开启代理）
  return getPreset(account.providerId).preferProxy
}
