import {
  Navigation,
  NavigationStack,
  List,
  Section,
  TextField,
  Button,
  Text,
  HStack,
  VStack,
  Image,
  Toggle,
  Markdown,
  Spacer,
  useState,
  useRef,
} from "scripting"
import { sendMail } from "../client"
import { getAccount } from "../storage"
import { isAiConfigured, rewriteDraft } from "../ai"
import type { DraftRewriteMode } from "../ai"
import type { EmailAccount, SendMailInput } from "../types"
import { AiSettingsView } from "./AiSettingsView"

type MailComposeProps = {
  accountId: string
  onSent?: () => void
  initialTo?: string
  initialSubject?: string
  initialBody?: string
  initialInReplyTo?: string
  initialReferences?: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1]
}

function uint8ArrayToBase64(uint8: Uint8Array): string {
  let binary = ""
  const len = uint8.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  return btoa(binary)
}

function preserveMarkdownLineBreaks(md: string): string {
  const lines = md.split("\n")
  return lines
    .map((line, index) => {
      if (index === lines.length - 1 || line.trim() === "") return line
      return line.endsWith("  ") ? line : `${line}  `
    })
    .join("\n")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function formatInlineMarkdown(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>")
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>")
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>")
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>")
  html = html.replace(/_(.+?)_/g, "<em>$1</em>")
  return html
}

function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n")
  const html: string[] = []
  let inList = false
  let listTag: "ul" | "ol" = "ul"
  let inCodeBlock = false
  let codeLines: string[] = []

  const closeList = () => {
    if (inList) {
      html.push(`</${listTag}>`)
      inList = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine
    const trimmed = line.trim()

    if (trimmed.startsWith("```")) {
      closeList()
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`)
        codeLines = []
        inCodeBlock = false
      } else {
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    if (!trimmed) {
      closeList()
      html.push("<br>")
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${formatInlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    if (/^---+$/.test(trimmed)) {
      closeList()
      html.push("<hr>")
      continue
    }

    const unorderedItem = trimmed.match(/^[-*]\s+(.+)$/)
    const orderedItem = trimmed.match(/^\d+\.\s+(.+)$/)
    if (unorderedItem || orderedItem) {
      const nextTag = unorderedItem ? "ul" : "ol"
      if (!inList || listTag !== nextTag) {
        closeList()
        listTag = nextTag
        html.push(`<${listTag}>`)
        inList = true
      }
      html.push(`<li>${formatInlineMarkdown((unorderedItem || orderedItem)![1])}</li>`)
      continue
    }

    const quote = trimmed.match(/^>\s?(.+)$/)
    if (quote) {
      closeList()
      html.push(`<blockquote>${formatInlineMarkdown(quote[1])}</blockquote>`)
      continue
    }

    closeList()
    html.push(`${formatInlineMarkdown(line)}<br>`)
  }

  closeList()
  if (inCodeBlock) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`)
  }

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.5; color: #222;">
${html.join("\n")}
</div>`
}

export function MailComposeView({
  accountId,
  onSent,
  initialTo = "",
  initialSubject = "",
  initialBody = "",
  initialInReplyTo = "",
  initialReferences = "",
}: MailComposeProps) {
  const dismiss = Navigation.useDismiss()
  const account = getAccount(accountId)

  const [toStr, setToStr] = useState(initialTo)
  const [ccStr, setCcStr] = useState("")
  const [bccStr, setBccStr] = useState("")
  const [subject, setSubject] = useState(initialSubject)
  const [bodyText, setBodyText] = useState(initialBody)
  const [sending, setSending] = useState(false)
  const [isMarkdown, setIsMarkdown] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [aiActiveMode, setAiActiveMode] = useState<string | null>(null)
  const aiWorking = aiActiveMode !== null
  // 互斥锁：防止并发 AI 请求导致正文混乱
  const aiLockRef = useRef(false)

  const insertMarkdown = (syntax: string) => {
    setBodyText(prev => {
      const spacing = prev.length > 0 && !prev.endsWith("\n") ? " " : ""
      return prev + spacing + syntax
    })
  }

  const insertBlock = (syntax: string) => {
    setBodyText(prev => {
      const prefix = prev.trim().length > 0 && !prev.endsWith("\n") ? "\n\n" : ""
      return prev + prefix + syntax
    })
  }

  const handleAiRewrite = async (mode: DraftRewriteMode) => {
    // 互斥：如果已有 AI 请求正在执行，直接忽略
    if (aiLockRef.current) return
    aiLockRef.current = true

    if (!isAiConfigured()) {
      aiLockRef.current = false
      const editSettings = await Dialog.confirm({
        title: "AI 配置未完成",
        message: "使用内容助手需要完整配置 AI 接口。是否立即前往配置？",
        confirmLabel: "前往",
        cancelLabel: "取消"
      })
      if (editSettings) Navigation.present(<AiSettingsView />)
      return
    }

    const source = bodyText.trim()
    if (!source && mode !== "continue") {
      aiLockRef.current = false
      Dialog.alert({ title: "提示", message: "请先输入需要处理的邮件正文" })
      return
    }

    setAiActiveMode(mode)
    try {
      const result = await rewriteDraft(bodyText, mode)
      setBodyText(result.text)
      setIsMarkdown(true)
      setShowPreview(true)
      if (result.truncated) {
        Dialog.alert({
          title: "正文已截断",
          message: "正文过长，本次 AI 处理仅使用了限制范围内的内容，请检查结果是否完整。",
        })
      }
    } catch (err: any) {
      Dialog.alert({ title: "AI 处理失败", message: err?.message || String(err) })
    } finally {
      setAiActiveMode(null)
      aiLockRef.current = false
    }
  }

  const [attachments, setAttachments] = useState<{ name: string; path: string; size: number }[]>([])

  const handleAddAttachment = async () => {
    try {
      const pickedPaths = await DocumentPicker.pickFiles({
        allowsMultipleSelection: true,
      })
      if (!pickedPaths || pickedPaths.length === 0) return

      const list = [...attachments]
      for (const p of pickedPaths) {
        if (list.some(item => item.path === p)) continue
        let fileSize = 0
        try {
          const bytes = await FileManager.readAsBytes(p)
          fileSize = bytes.length
        } catch (err) {
          console.error("读取文件大小失败: " + p, err)
        }
        list.push({
          name: getFileName(p),
          path: p,
          size: fileSize,
        })
      }
      setAttachments(list)
    } catch (err: any) {
      Dialog.alert({ title: "添加附件失败", message: err?.message || String(err) })
    }
  }

  const handleRemoveAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }

  const handleSend = async () => {
    if (!account) return

    const to = toStr
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
    if (to.length === 0) {
      Dialog.alert({ title: "提示", message: "请输入至少一个收件人" })
      return
    }

    if (!subject.trim()) {
      Dialog.alert({ title: "提示", message: "请输入邮件主题" })
      return
    }

    setSending(true)

    // 读取所有附件并将其转为 base64
    const resolvedAttachments = []
    for (const att of attachments) {
      try {
        const bytes = await FileManager.readAsBytes(att.path)
        const contentB64 = uint8ArrayToBase64(bytes)
        const mimeType = FileManager.mimeType(att.path) || "application/octet-stream"
        resolvedAttachments.push({
          filename: att.name,
          content: contentB64,
          mimeType,
        })
      } catch (err: any) {
        setSending(false)
        Dialog.alert({
          title: "读取附件出错",
          message: `无法读取文件 ${att.name}：${err?.message || String(err)}`,
        })
        return
      }
    }

    const mailInput: SendMailInput = {
      to,
      subject: subject.trim(),
      attachments: resolvedAttachments,
      inReplyTo: initialInReplyTo || undefined,
      references: initialReferences || undefined,
    }

    if (isMarkdown) {
      mailInput.html = markdownToHtml(bodyText)
      mailInput.text = bodyText
    } else {
      mailInput.text = bodyText
    }

    if (ccStr.trim()) {
      mailInput.cc = ccStr
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
    }

    if (bccStr.trim()) {
      mailInput.bcc = bccStr
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
    }

    const res = await sendMail(account, mailInput)
    setSending(false)

    if (res.ok) {
      Dialog.alert({
        title: "发送成功",
        message: "邮件已投递至代理中转并成功送达服务器。",
      }).then(() => {
        if (onSent) onSent()
        dismiss()
      })
    } else {
      Dialog.alert({
        title: "发送失败",
        message: res.error || "未知网络投递错误",
      })
    }
  }

  if (!account) {
    return (
      <NavigationStack>
        <List
          navigationTitle="写邮件"
          navigationBarTitleDisplayMode="inline"
          toolbar={{
            cancellationAction: <Button title="关闭" action={dismiss} />,
          }}
        >
          <Section>
            <Text>未选定发件人账户，请先到管理面绑定邮箱。</Text>
          </Section>
        </List>
      </NavigationStack>
    )
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="写邮件"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="取消" action={dismiss} />,
          confirmationAction: (
            <Button
              title={sending ? "正在发送..." : "发送"}
              systemImage="paperplane.fill"
              action={handleSend}
              disabled={sending}
            />
          ),
        }}
      >
        <Section header={<Text>发件账户</Text>}>
          <HStack>
            <Text fontWeight="semibold">发件人:</Text>
            <Text>{account.email}</Text>
          </HStack>
        </Section>

        <Section header={<Text>收件人</Text>} footer={<Text>多个邮箱请用英文逗号 (,) 分隔</Text>}>
          <TextField
            title="收件人"
            prompt="recipient@example.com"
            value={toStr}
            onChanged={toStrVal => setToStr(toStrVal)}
          />
          <TextField
            title="抄送 (Cc)"
            prompt="cc@example.com"
            value={ccStr}
            onChanged={ccStrVal => setCcStr(ccStrVal)}
          />
          <TextField
            title="密送 (Bcc)"
            prompt="bcc@example.com"
            value={bccStr}
            onChanged={bccStrVal => setBccStr(bccStrVal)}
          />
        </Section>

        <Section header={<Text>邮件格式设置</Text>}>
          <Toggle
            title="富文本模式 (Markdown)"
            value={isMarkdown}
            onChanged={(val) => {
              setIsMarkdown(val)
              if (!val) setShowPreview(false)
            }}
          />
          {isMarkdown && (
            <Toggle
              title="实时效果预览"
              value={showPreview}
              onChanged={setShowPreview}
            />
          )}
        </Section>

        <Section header={<Text>邮件主题</Text>}>
          <TextField
            title="主题"
            prompt="输入邮件主题"
            value={subject}
            onChanged={setSubject}
          />
        </Section>

        {isMarkdown && (
          <Section header={<Text>快捷排版工具</Text>}>
            <VStack spacing={10} padding={{ vertical: 4 }}>
              <HStack foregroundStyle="systemBlue" buttonStyle="plain">
                <Spacer />
                <Button key="bold" action={() => insertMarkdown("**粗体文本**")}>
                  <Image systemName="bold" />
                </Button>
                <Spacer />
                <Button key="italic" action={() => insertMarkdown("*斜体文本*")}>
                  <Image systemName="italic" />
                </Button>
                <Spacer />
                <Button key="strike" action={() => insertMarkdown("~~删除线文本~~")}>
                  <Image systemName="strikethrough" />
                </Button>
                <Spacer />
                <Button key="heading" action={() => insertBlock("## 二级标题\n") }>
                  <Image systemName="number" />
                </Button>
                <Spacer />
                <Button key="divider" action={() => insertBlock("---\n") }>
                  <Image systemName="minus" />
                </Button>
                <Spacer />
              </HStack>
              <HStack foregroundStyle="systemBlue" buttonStyle="plain">
                <Spacer />
                <Button key="bullet" action={() => insertBlock("- 列表项\n- 列表项\n") }>
                  <Image systemName="list.bullet" />
                </Button>
                <Spacer />
                <Button key="ordered" action={() => insertBlock("1. 第一项\n2. 第二项\n") }>
                  <Image systemName="list.number" />
                </Button>
                <Spacer />
                <Button key="link" action={() => insertMarkdown("[链接文字](https://链接地址)")}>
                  <Image systemName="link" />
                </Button>
                <Spacer />
                <Button key="quote" action={() => insertBlock("> 引用内容\n") }>
                  <Image systemName="text.quote" />
                </Button>
                <Spacer />
                <Button key="code" action={() => insertBlock("```\n代码块\n```\n") }>
                  <Image systemName="chevron.left.forwardslash.chevron.right" />
                </Button>
                <Spacer />
              </HStack>
            </VStack>
          </Section>
        )}

        <Section header={<Text>AI 内容助手</Text>} footer={<Text>根据当前正文处理，自动切换为 Markdown 预览。</Text>}>
          <HStack buttonStyle="plain" padding={{ vertical: 4 }}>
            <Spacer />
            <Button key="polish" action={() => handleAiRewrite("polish")} disabled={aiWorking}>
              <VStack spacing={4}>
                <Image
                  systemName={aiActiveMode === "polish" ? "hourglass" : "sparkles"}
                  font={18}
                  foregroundStyle={aiActiveMode === "polish" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "systemBlue"}
                />
                <Text font={12} foregroundStyle={aiActiveMode === "polish" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "label"}>
                  {aiActiveMode === "polish" ? "处理中" : "润色"}
                </Text>
              </VStack>
            </Button>
            <Spacer />
            <Button key="continue" action={() => handleAiRewrite("continue")} disabled={aiWorking}>
              <VStack spacing={4}>
                <Image
                  systemName={aiActiveMode === "continue" ? "hourglass" : "text.append"}
                  font={18}
                  foregroundStyle={aiActiveMode === "continue" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "systemBlue"}
                />
                <Text font={12} foregroundStyle={aiActiveMode === "continue" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "label"}>
                  {aiActiveMode === "continue" ? "处理中" : "续写"}
                </Text>
              </VStack>
            </Button>
            <Spacer />
            <Button key="format" action={() => handleAiRewrite("format")} disabled={aiWorking}>
              <VStack spacing={4}>
                <Image
                  systemName={aiActiveMode === "format" ? "hourglass" : "text.alignleft"}
                  font={18}
                  foregroundStyle={aiActiveMode === "format" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "systemBlue"}
                />
                <Text font={12} foregroundStyle={aiActiveMode === "format" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "label"}>
                  {aiActiveMode === "format" ? "处理中" : "格式优化"}
                </Text>
              </VStack>
            </Button>
            <Spacer />
            <Button key="shorten" action={() => handleAiRewrite("shorten")} disabled={aiWorking}>
              <VStack spacing={4}>
                <Image
                  systemName={aiActiveMode === "shorten" ? "hourglass" : "scissors"}
                  font={18}
                  foregroundStyle={aiActiveMode === "shorten" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "systemBlue"}
                />
                <Text font={12} foregroundStyle={aiActiveMode === "shorten" ? "systemOrange" : aiWorking ? "tertiaryLabel" : "label"}>
                  {aiActiveMode === "shorten" ? "处理中" : "精简"}
                </Text>
              </VStack>
            </Button>
            <Spacer />
          </HStack>
        </Section>

        {showPreview && isMarkdown && !!bodyText.trim() && (
          <Section header={<Text>Markdown 效果预览</Text>}>
            <Markdown content={preserveMarkdownLineBreaks(bodyText)} scrollable={false} />
          </Section>
        )}
        <Section header={<Text>邮件正文</Text>}>
          <TextField
            label={
              <VStack alignment="leading" spacing={4} padding={{ bottom: 8 }}>
                <Text font={13} fontWeight="semibold" foregroundStyle="secondaryLabel">
                  {isMarkdown ? "正文 (Markdown)" : "正文内容"}
                </Text>
              </VStack>
            }
            prompt={isMarkdown ? "使用 Markdown 格式书写邮件..." : "在这开始写信..."}
            value={bodyText}
            onChanged={setBodyText}
            axis="vertical"
            lineLimit={{ min: 10, max: 30, reservesSpace: true }}
          />
        </Section>

        <Section header={<Text>附件管理</Text>}>
          <Button
            title="添加文件附件"
            systemImage="doc.badge.plus"
            action={handleAddAttachment}
          />
          {attachments.map((att, idx) => (
            <HStack key={att.path} spacing={12} padding={{ vertical: 4 }}>
              <Image systemName="paperclip" foregroundStyle="gray" />
              <VStack alignment="leading" spacing={2}>
                <Text font={14} fontWeight="semibold">{att.name}</Text>
                <Text font={12} foregroundStyle="gray">{formatBytes(att.size)}</Text>
              </VStack>
              <Spacer />
              <Button
                title=""
                systemImage="trash"
                role="destructive"
                action={() => handleRemoveAttachment(idx)}
              />
            </HStack>
          ))}
        </Section>
      </List>
    </NavigationStack>
  )
}
