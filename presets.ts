import type { EmailProviderId, ProviderPreset } from "./types"

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    domainHints: ["gmail.com", "googlemail.com"],
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpStartTLS: false,
    preferProxy: true,
    hint: "需开启两步验证并使用「应用专用密码」，建议经 Cloudflare Worker 中转",
  },
  {
    id: "outlook",
    name: "Outlook / Hotmail",
    domainHints: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
    smtpStartTLS: true,
    preferProxy: true,
    hint: "微软账号可能需要应用密码或 OAuth；默认建议走代理",
  },
  {
    id: "icloud",
    name: "iCloud",
    domainHints: ["icloud.com", "me.com", "mac.com"],
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
    smtpStartTLS: true,
    preferProxy: true,
    hint: "需在 appleid.apple.com 生成 App 专用密码",
  },
  {
    id: "qq",
    name: "QQ 邮箱",
    domainHints: ["qq.com", "foxmail.com"],
    imapHost: "imap.qq.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpStartTLS: false,
    preferProxy: false,
    hint: "在 QQ 邮箱设置中开启 IMAP 并使用授权码",
  },
  {
    id: "163",
    name: "网易 163",
    domainHints: ["163.com", "126.com", "yeah.net"],
    imapHost: "imap.163.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpStartTLS: false,
    preferProxy: false,
    hint: "需开启 IMAP/SMTP 服务并使用授权码",
  },
  {
    id: "custom",
    name: "自定义",
    domainHints: [],
    imapHost: "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "",
    smtpPort: 465,
    smtpSecure: true,
    smtpStartTLS: false,
    preferProxy: true,
    hint: "手动填写 IMAP / SMTP 服务器信息",
  },
]

export function getPreset(id: EmailProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find(item => item.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
}

export function guessProviderByEmail(email: string): ProviderPreset {
  const domain = email.split("@")[1]?.toLowerCase() ?? ""
  if (!domain) return getPreset("custom")

  const matched = PROVIDER_PRESETS.find(preset =>
    preset.domainHints.some(hint => domain === hint || domain.endsWith(`.${hint}`)),
  )
  return matched ?? getPreset("custom")
}
