import {
  Navigation,
  NavigationStack,
  List,
  Section,
  Button,
  Text,
  HStack,
  VStack,
  Image,
  WebView,
  Picker,
  useState,
  useEffect,
  Spacer,
  Divider,
  ScrollView,
  Markdown,
  ProgressView,
} from "scripting"
import { getMessage, applyMailAction, formatDateLabel } from "../client"
import { isAiConfigured, summarizeMail, translateMail } from "../ai"
import { MailComposeView } from "./MailComposeView"
import type { EmailAccount, MailMessageDetail } from "../types"
import { AiSettingsView } from "./AiSettingsView"

// WebViewController global typings
declare const WebViewController: any;

type MailDetailProps = {
  account: EmailAccount
  uid: number
  folder: string
  onActionComplete?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

export function MailDetailView({ account, uid, folder, onActionComplete }: MailDetailProps) {
  const dismiss = Navigation.useDismiss()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mail, setMail] = useState<MailMessageDetail | null>(null)
  const [viewMode, setViewMode] = useState<"html" | "text">("html")

  const [translatedText, setTranslatedText] = useState<string | null>(null)
  const [translatedHtml, setTranslatedHtml] = useState<string | null>(null)
  const [showingTranslation, setShowingTranslation] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [translatedSubject, setTranslatedSubject] = useState<string | null>(null)

  // WebView 控制器用于安全渲染邮件的 HTML 内容
  const [webViewController] = useState(() => new WebViewController())

  useEffect(() => {
    loadMail()
    return () => {
      // 卸载时手动 dispose 避免内存泄露
      webViewController.dispose()
    }
  }, [uid])

  const loadMail = async () => {
    setLoading(true)
    setError(null)
    const res = await getMessage(account, uid, folder)
    if (res.ok) {
      setMail(res.data)
      setLoading(false)
      // 如果有 HTML 内容，载入 WebView
      if (res.data.html) {
        webViewController.loadHTML(injectHtmlStyles(res.data.html))
      }
      // 自动标记为已读
      if (!res.data.seen) {
        applyMailAction(account, { type: "markSeen", uids: [uid], seen: true }, folder).then(() => {
          if (onActionComplete) onActionComplete()
        })
      }
    } else {
      setError(res.error)
      setLoading(false)
    }
  }

  // 注入自适应 CSS，确保邮件在手机屏幕上布局正常、文字可读
  const injectHtmlStyles = (html: string) => {
    const defaultStyles = `
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 16px;
          line-height: 1.5;
          color: #333333;
          padding: 12px;
          margin: 0;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }
        img {
          max-width: 100% !important;
          height: auto !important;
        }
        pre, code {
          white-space: pre-wrap;
          word-break: break-all;
        }
      </style>
    `
    // 如果没有 head，创建一个
    if (html.includes("<head>")) {
      return html
        .replace("<head>", `<head>${defaultStyles}`)
    } else if (html.includes("<html>")) {
      return html
        .replace("<html>", `<html><head>${defaultStyles}</head>`)
    } else {
      return `<html><head>${defaultStyles}</head><body>${html}</body></html>`
    }
  }

  const handleToggleFlagged = async () => {
    if (!mail) return
    const nextFlagged = !mail.flagged
    const res = await applyMailAction(account, { type: "flag", uids: [uid], flagged: nextFlagged }, folder)
    if (res.ok) {
      setMail((prev: any) => (prev ? { ...prev, flagged: nextFlagged } : null))
      if (onActionComplete) onActionComplete()
    } else {
      Dialog.alert({ title: "操作失败", message: res.error })
    }
  }

  const handleDelete = async () => {
    const confirmed = await Dialog.confirm({
      title: "删除邮件",
      message: "确认将该邮件永久删除吗？",
      confirmLabel: "删除",
      cancelLabel: "保留",
    })
    if (!confirmed) return

    const res = await applyMailAction(account, { type: "delete", uids: [uid] }, folder)
    if (res.ok) {
      if (onActionComplete) onActionComplete()
      dismiss()
    } else {
      Dialog.alert({ title: "删除失败", message: res.error })
    }
  }

  const handleReply = () => {
    if (!mail) return

    const replySubject = mail.subject.toLowerCase().startsWith("re:")
      ? mail.subject
      : `Re: ${mail.subject}`

    const replyTo = mail.from?.[0]?.address || ""

    // 格式化引用正文
    const formattedDate = mail.date ? new Date(mail.date).toLocaleString() : ""
    const senderName = mail.from?.[0]?.name || mail.from?.[0]?.address || ""
    const quotedBody = `\n\nOn ${formattedDate}, ${senderName} wrote:\n> ${
      mail.text ? mail.text.split("\n").join("\n> ") : ""
    }`

    const inReplyTo = mail.messageId || ""
    const references = mail.references
      ? `${mail.references} ${mail.messageId || ""}`.trim()
      : mail.messageId || ""

    Navigation.present({
      element: (
        <MailComposeView
          accountId={account.id}
          initialTo={replyTo}
          initialSubject={replySubject}
          initialBody={quotedBody}
          initialInReplyTo={inReplyTo}
          initialReferences={references}
        />
      ),
      modalPresentationStyle: "fullScreen",
    })
  }

  const handleAttachmentTap = async (att: any) => {
    if (!att.content) {
      Dialog.alert({ title: "提示", message: "附件数据为空" })
      return
    }

    try {
      const binaryString = atob(att.content)
      const len = binaryString.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      const tempPath = FileManager.temporaryDirectory + "/" + att.filename
      await FileManager.writeAsBytes(tempPath, bytes)

      await QuickLook.previewURLs([tempPath])
    } catch (err: any) {
      Dialog.alert({
        title: "预览失败",
        message: err?.message || String(err)
      })
    }
  }

  const handleSummarize = async () => {
    if (!mail) return

    if (!isAiConfigured()) {
      const editSettings = await Dialog.confirm({
        title: "AI 配置未完成",
        message: "使用一键总结功能需要完整配置 AI 接口。是否立即前往配置？",
        confirmLabel: "前往",
        cancelLabel: "取消"
      })
      if (editSettings) {
        Navigation.present(<AiSettingsView />)
      }
      return
    }

    setSummarizing(true)
    try {
      const summary = await summarizeMail(mail)

      Navigation.present(
        <NavigationStack>
          <ScrollView padding={16} navigationTitle="AI 邮件摘要" navigationBarTitleDisplayMode="inline">
            <VStack alignment="leading" spacing={16}>
              <HStack spacing={8}>
                <Image systemName="sparkles" font={18} foregroundStyle="systemBlue" />
                <Text font={17} fontWeight="bold">智能总结概要</Text>
              </HStack>
              <Divider />
              {summary.truncated ? (
                <Text font={13} foregroundStyle="systemOrange">
                  邮件内容过长，本摘要仅基于限制范围内的正文生成。
                </Text>
              ) : null}
              <Markdown content={summary.text} />
            </VStack>
          </ScrollView>
        </NavigationStack>
      )
    } catch (err: any) {
      Dialog.alert({ title: "总结失败", message: err?.message || String(err) })
    } finally {
      setSummarizing(false)
    }
  }

  const handleTranslateToggle = async () => {
    if (!mail) return

    if (showingTranslation) {
      setShowingTranslation(false)
      if (mail.html) {
        webViewController.loadHTML(injectHtmlStyles(mail.html))
      }
      return
    }

    if (mail.html && translatedHtml) {
      setShowingTranslation(true)
      webViewController.loadHTML(injectHtmlStyles(translatedHtml))
      return
    }

    if (!mail.html && translatedText) {
      setShowingTranslation(true)
      return
    }

    if (!isAiConfigured()) {
      const editSettings = await Dialog.confirm({
        title: "AI 配置未完成",
        message: "使用翻译邮件功能需要完整配置 AI 接口。是否立即前往配置？",
        confirmLabel: "前往",
        cancelLabel: "取消"
      })
      if (editSettings) {
        Navigation.present(<AiSettingsView />)
      }
      return
    }

    setTranslating(true)
    try {
      const translation = await translateMail(mail)

      if (translation.html) {
        setTranslatedHtml(translation.html)
        webViewController.loadHTML(injectHtmlStyles(translation.html))
      }
      if (translation.text) {
        setTranslatedText(translation.text)
      }
      setTranslatedSubject(translation.subject)
      setShowingTranslation(true)

      if (translation.truncated) {
        const labels = translation.truncatedFields.map(field => ({
          subject: "主题",
          html: "HTML 正文",
          text: "纯文本正文",
        })[field])
        Dialog.alert({
          title: "内容已截断",
          message: `${labels.join("、")}过长，本次仅翻译了限制范围内的内容。`,
        })
      }
    } catch (err: any) {
      Dialog.alert({ title: "翻译失败", message: err?.message || String(err) })
    } finally {
      setTranslating(false)
    }
  }

  const getAvatarChar = () => {
    if (!mail?.from?.[0]) return "?"
    const name = mail.from[0].name || mail.from[0].address || "?"
    return name.trim().charAt(0).toUpperCase()
  }

  const getAvatarBg = (char: string) => {
    const code = char.charCodeAt(0) % 5
    const colors = ["#4CD964", "#007AFF", "#5856D6", "#FF9500", "#FF2D55"]
    return colors[code]
  }

  if (loading) {
    return (
      <VStack
        alignment="center"
        spacing={12}
        navigationTitle="邮件正文"
        navigationBarTitleDisplayMode="inline"
      >
        <Text>正在获取邮件详情...</Text>
      </VStack>
    )
  }

  if (error) {
    return (
      <VStack
        alignment="center"
        spacing={12}
        padding={16}
        navigationTitle="邮件正文"
        navigationBarTitleDisplayMode="inline"
      >
        <Image systemName="exclamationmark.triangle" font={28} foregroundStyle="red" />
        <Text fontWeight="semibold">拉取失败</Text>
        <Text font={14} multilineTextAlignment="center">
          {error}
        </Text>
        <Button title="重试" action={loadMail} />
      </VStack>
    )
  }

  if (!mail) {
    return (
      <VStack
        alignment="center"
        navigationTitle="邮件正文"
        navigationBarTitleDisplayMode="inline"
      >
        <Text foregroundStyle="gray">邮件不存在</Text>
      </VStack>
    )
  }

  const avatarChar = getAvatarChar()
  const avatarBg = getAvatarBg(avatarChar)

  return (
    <VStack
      alignment="leading"
      spacing={0}
      background="systemBackground"
      navigationTitle="邮件正文"
      navigationBarTitleDisplayMode="inline"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      toolbar={{
        confirmationAction: (
          <HStack spacing={16}>
            <Button
              title="回复"
              systemImage="arrowshape.turn.up.left"
              action={handleReply}
              disabled={loading}
            />
            <Button
              title={mail.flagged ? "取消星标" : "星标"}
              systemImage={mail.flagged ? "star.fill" : "star"}
              action={handleToggleFlagged}
              disabled={loading}
            />
            <Button
              title="删除"
              systemImage="trash"
              role="destructive"
              action={handleDelete}
              disabled={loading}
            />
          </HStack>
        ),
      }}
    >
      {/* 邮件标题 */}
      <VStack alignment="leading" spacing={12} padding={{ top: 16, horizontal: 16, bottom: 8 }} background="systemBackground">
        <Text font={20} fontWeight="bold" lineLimit={3}>
          {showingTranslation ? (translatedSubject || mail.subject || "(无主题)") : (mail.subject || "(无主题)")}
        </Text>

        {/* 发件人与收件人排版（高仿系统客户端） */}
        <HStack spacing={12} alignment="center">
          {/* 头像 */}
          <VStack
            alignment="center"
            frame={{ width: 40, height: 40 }}
            background={{ style: avatarBg as any, shape: { type: "rect", cornerRadius: 20 } }}
          >
            <Text font={18} fontWeight="bold" foregroundStyle="#FFFFFF">
              {avatarChar}
            </Text>
          </VStack>

          {/* 姓名和收发信息 */}
          <VStack alignment="leading" spacing={2}>
            <Text font={15} fontWeight="semibold">
              {mail.from?.[0]?.name || mail.from?.[0]?.address || "(无发件人)"}
            </Text>
            <Text font={12} foregroundStyle="gray">
              发至 {mail.to?.[0]?.name || mail.to?.[0]?.address || ""}
            </Text>
          </VStack>

          <Spacer />

          {/* 时间 */}
          <Text font={12} foregroundStyle="gray">
            {mail.date ? formatDateLabel(mail.date) : ""}
          </Text>
        </HStack>
      </VStack>

      {/* AI 智能助手 Banner */}
      <HStack
        spacing={8}
        padding={{ vertical: 8, horizontal: 16 }}
        background="secondarySystemBackground"
      >
        <Image systemName="sparkles" font={14} foregroundStyle="systemBlue" />
        <Text font={13} foregroundStyle="secondaryLabel">
          {summarizing ? "正在分析概要..." : translating ? "正在翻译正文..." : "AI 智能助手已就绪"}
        </Text>
        <Spacer />
        <HStack spacing={12}>
          <Button
            title="一键总结"
            font={13}
            foregroundStyle={summarizing || translating ? "gray" : "systemBlue"}
            action={handleSummarize}
            disabled={summarizing || translating}
          />
          <Button
            title={showingTranslation ? "显示原文" : "翻译邮件"}
            font={13}
            foregroundStyle={summarizing || translating ? "gray" : "systemBlue"}
            action={handleTranslateToggle}
            disabled={summarizing || translating}
          />
        </HStack>
      </HStack>

      {/* 视图切换：如果同时有 html 和 text，则显示 */}
      {mail.html && mail.text ? (
        <VStack padding={{ vertical: 6, horizontal: 16 }} background="systemBackground">
          <Picker
            title="视图切换"
            value={viewMode}
            onChanged={(val: any) => setViewMode(val)}
            pickerStyle="segmented"
          >
            <Text tag="html">富文本</Text>
            <Text tag="text">纯文本</Text>
          </Picker>
        </VStack>
      ) : null}

      <Divider />

      {/* 邮件正文渲染区，WebView 自适应占满屏幕 */}
      <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        {translating ? (
          <VStack alignment="center" spacing={16} padding={64} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <Spacer />
            <ProgressView />
            <Text font={15} foregroundStyle="secondaryLabel">AI 正在进行全文翻译中，请稍候...</Text>
            <Spacer />
          </VStack>
        ) : viewMode === "html" && mail.html ? (
          <WebView
            controller={webViewController}
          />
        ) : mail.text ? (
          <ScrollView padding={16}>
            <Text font={15} multilineTextAlignment="leading" textSelection={true}>
              {showingTranslation ? (translatedText || mail.text) : mail.text}
            </Text>
          </ScrollView>
        ) : (
          <VStack alignment="center" padding={32}>
            <Text font={15} foregroundStyle="gray">
              此邮件没有正文内容
            </Text>
          </VStack>
        )}
      </VStack>

      {/* 附件展示与下载预览区 */}
      {mail.attachments && mail.attachments.length > 0 ? (
        <VStack spacing={8} padding={{ vertical: 12, horizontal: 16 }} background="secondarySystemBackground">
          <Text font={13} fontWeight="semibold" foregroundStyle="secondaryLabel">
            附件 ({mail.attachments.length}个)
          </Text>
          <ScrollView axes="horizontal">
            <HStack spacing={12}>
              {mail.attachments.map((att: any, index: number) => (
                <HStack
                  key={index}
                  spacing={8}
                  padding={{ vertical: 8, horizontal: 12 }}
                  background={{ style: "systemBackground" as any, shape: { type: "rect", cornerRadius: 8 } }}
                  onTapGesture={() => handleAttachmentTap(att)}
                >
                  <Image systemName="doc.fill" font={14} foregroundStyle="systemBlue" />
                  <VStack alignment="leading" spacing={2}>
                    <Text font={13} fontWeight="medium" lineLimit={1}>
                      {att.filename}
                    </Text>
                    <Text font={11} foregroundStyle="gray">
                      {formatBytes(att.size || 0)}
                    </Text>
                  </VStack>
                </HStack>
              ))}
            </HStack>
          </ScrollView>
        </VStack>
      ) : null}
    </VStack>
  )
}
