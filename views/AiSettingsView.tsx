import {
  Navigation,
  NavigationStack,
  List,
  Section,
  TextField,
  SecureField,
  Button,
  Text,
  Toggle,
  useState,
  HStack,
  Spacer,
  Image,
} from "scripting"
import { listAvailableModels } from "../ai"
import { getProxySettings, saveProxySettings } from "../storage"

type SecretFieldRowProps = {
  title: string
  prompt: string
  value: string
  onChanged: (value: string) => void
  revealed: boolean
  onToggle: () => void
}

function SecretFieldRow({
  title,
  prompt,
  value,
  onChanged,
  revealed,
  onToggle,
}: SecretFieldRowProps) {
  return (
    <HStack spacing={8} frame={{ height: 44 }}>
      {revealed ? (
        <TextField title={title} prompt={prompt} value={value} onChanged={onChanged} />
      ) : (
        <SecureField title={title} prompt={prompt} value={value} onChanged={onChanged} />
      )}
      <Button action={onToggle} frame={{ width: 44, height: 44 }}>
        <Image
          systemName={revealed ? "eye.slash" : "eye"}
          foregroundStyle="systemBlue"
        />
      </Button>
    </HStack>
  )
}

export function AiSettingsView() {
  const dismiss = Navigation.useDismiss()
  const currentSettings = getProxySettings()
  const [aiApiUrl, setAiApiUrl] = useState(currentSettings.aiApiUrl || "https://api.openai.com/v1")
  const [aiApiKey, setAiApiKey] = useState(currentSettings.aiApiKey || "")
  const [aiModel, setAiModel] = useState(currentSettings.aiModel || "gpt-4o-mini")
  const [aiTargetLang, setAiTargetLang] = useState(currentSettings.aiTargetLang || "简体中文")
  const [aiTimeoutStr, setAiTimeoutStr] = useState(String(currentSettings.aiTimeoutSeconds || 60))
  const [aiRequiresApiKey, setAiRequiresApiKey] = useState(currentSettings.aiRequiresApiKey !== false)
  const [showAiApiKey, setShowAiApiKey] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)

  const handleFetchModels = async () => {
    setFetchingModels(true)
    try {
      const parsedTimeout = parseInt(aiTimeoutStr, 10)
      const modelIds = await listAvailableModels({
        baseUrl: aiApiUrl,
        apiKey: aiApiKey,
        model: aiModel,
        timeoutSeconds: Number.isNaN(parsedTimeout) ? 30 : Math.min(parsedTimeout, 30),
        requiresApiKey: aiRequiresApiKey,
      })
      const selectedIndex = await Dialog.actionSheet({
        title: "选择大模型",
        message: `共拉取到 ${modelIds.length} 个可用模型`,
        actions: modelIds.map((id: string) => ({ label: id })),
      })
      if (selectedIndex != null) setAiModel(modelIds[selectedIndex])
    } catch (error: any) {
      Dialog.alert({
        title: "拉取模型失败",
        message: error?.message || String(error),
      })
    } finally {
      setFetchingModels(false)
    }
  }

  const handleSave = () => {
    const normalizedApiUrl = aiApiUrl.trim()
    const aiTimeoutVal = parseInt(aiTimeoutStr, 10)
    if (!normalizedApiUrl.startsWith("http://") && !normalizedApiUrl.startsWith("https://")) {
      Dialog.alert({ title: "格式错误", message: "AI 接口地址必须以 http:// 或 https:// 开头" })
      return
    }
    if (/\/(chat\/completions|models)\/?$/i.test(normalizedApiUrl)) {
      Dialog.alert({
        title: "格式错误",
        message: "请填写 AI 基础地址，不要包含 /chat/completions 或 /models",
      })
      return
    }
    if (aiRequiresApiKey && !aiApiKey.trim()) {
      Dialog.alert({
        title: "配置不完整",
        message: "当前接口设置为需要 API Key，请填写 Key 或关闭该开关",
      })
      return
    }

    saveProxySettings({
      ...currentSettings,
      aiApiUrl: normalizedApiUrl,
      aiApiKey,
      aiModel,
      aiTargetLang,
      aiTimeoutSeconds: Number.isNaN(aiTimeoutVal) ? 60 : aiTimeoutVal,
      aiRequiresApiKey,
    })
    Dialog.alert({ title: "成功", message: "AI 设置保存成功" }).then(dismiss)
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="AI 智能助理设置"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="取消" action={dismiss} />,
          confirmationAction: <Button title="保存" action={handleSave} />,
        }}
      >
        <Section
          header={<Text>OpenAI 兼容接口</Text>}
          footer={<Text>关闭鉴权开关后不会发送 Authorization，可连接无需 Key 的本地服务。</Text>}
        >
          <TextField
            title="接口地址"
            prompt="例如 https://api.openai.com/v1"
            value={aiApiUrl}
            onChanged={setAiApiUrl}
          />
          <Toggle
            title="接口需要 API Key"
            value={aiRequiresApiKey}
            onChanged={setAiRequiresApiKey}
          />
          <SecretFieldRow
            title="API Key"
            prompt={aiRequiresApiKey ? "sk-..." : "可留空"}
            value={aiApiKey}
            onChanged={setAiApiKey}
            revealed={showAiApiKey}
            onToggle={() => setShowAiApiKey(value => !value)}
          />
        </Section>

        <Section header={<Text>模型与生成设置</Text>}>
          <TextField
            title="模型名称"
            prompt="例如 gpt-4o-mini"
            value={aiModel}
            onChanged={setAiModel}
          />
          <HStack spacing={12} padding={{ vertical: 4 }}>
            <Text font={13} foregroundStyle="gray">不知道填什么？</Text>
            <Spacer />
            <Button
              title={fetchingModels ? "正在拉取..." : "点击拉取并选择模型"}
              font={13}
              foregroundStyle="systemBlue"
              action={handleFetchModels}
              disabled={fetchingModels}
            />
          </HStack>
          <TextField
            title="目标语言"
            prompt="例如 简体中文"
            value={aiTargetLang}
            onChanged={setAiTargetLang}
          />
          <TextField
            title="超时时间 (秒)"
            prompt="默认 60 秒"
            value={aiTimeoutStr}
            onChanged={setAiTimeoutStr}
            keyboardType="numberPad"
          />
        </Section>
      </List>
    </NavigationStack>
  )
}
