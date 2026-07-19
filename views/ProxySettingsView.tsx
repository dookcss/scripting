import {
  Navigation,
  NavigationStack,
  List,
  Section,
  TextField,
  SecureField,
  Button,
  Text,
  Picker,
  useState,
  HStack,
  Image,
} from "scripting"
import { getProxySettings, saveProxySettings } from "../storage"
import type { ProxyMode } from "../types"

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
        <TextField
          title={title}
          prompt={prompt}
          value={value}
          onChanged={onChanged}
        />
      ) : (
        <SecureField
          title={title}
          prompt={prompt}
          value={value}
          onChanged={onChanged}
        />
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

export function ProxySettingsView() {
  const dismiss = Navigation.useDismiss()
  const currentSettings = getProxySettings()

  const [workerUrl, setWorkerUrl] = useState(currentSettings.workerUrl)
  const [authToken, setAuthToken] = useState(currentSettings.authToken)
  const [mode, setMode] = useState<ProxyMode>(currentSettings.mode)
  const [timeoutStr, setTimeoutStr] = useState(String(currentSettings.timeoutSeconds))
  const [localUrl, setLocalUrl] = useState(currentSettings.localUrl || "")
  const [localToken, setLocalToken] = useState(currentSettings.localToken || "")
  const [showLocalToken, setShowLocalToken] = useState(false)
  const [showAuthToken, setShowAuthToken] = useState(false)

  const handleSave = () => {
    const timeoutVal = parseInt(timeoutStr, 10)
    if (workerUrl && !workerUrl.startsWith("http://") && !workerUrl.startsWith("https://")) {
      Dialog.alert({
        title: "格式错误",
        message: "Worker 地址必须以 http:// 或 https:// 开头",
      })
      return
    }

    if (localUrl && !localUrl.startsWith("http://") && !localUrl.startsWith("https://")) {
      Dialog.alert({
        title: "格式错误",
        message: "本地服务地址必须以 http:// 或 https:// 开头",
      })
      return
    }


    saveProxySettings({
      ...currentSettings,
      workerUrl,
      authToken,
      mode,
      timeoutSeconds: Number.isNaN(timeoutVal) ? 45 : timeoutVal,
      localUrl,
      localToken,
    })

    Dialog.alert({
      title: "成功",
      message: "邮件服务器设置保存成功",
    }).then(() => {
      dismiss()
    })
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="邮件服务器与中转设置"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="取消" action={dismiss} />,
          confirmationAction: <Button title="保存" action={handleSave} />,
        }}
      >
        <Section
          header={<Text>中转模式</Text>}
          footer={<Text>自动模式下，除了 QQ、163 等国内邮箱，其余邮箱（如 Gmail）默认经由 Worker 中转以避开直连限制。</Text>}
        >
          <Picker
            title="代理策略"
            value={mode}
            onChanged={(val: string) => setMode(val as ProxyMode)}
          >
            <Text tag="auto">自动 (仅国外邮箱代理)</Text>
            <Text tag="proxy">始终代理 (全部走 Worker)</Text>
            <Text tag="direct">直连 (不走任何代理)</Text>
          </Picker>
        </Section>

        {mode === "auto" ? (
          <Section
            header={<Text>本地直连中转服务（针对 QQ / 163 等国内邮箱）</Text>}
            footer={<Text>国内邮箱由于直连限制，需要你在电脑上运行本地中转服务并在上方填写电脑的局域网 IP（不可填写 localhost）。</Text>}
          >
            <TextField
              title="本地服务地址"
              prompt="例如 http://192.168.1.100:18000"
              value={localUrl}
              onChanged={setLocalUrl}
            />
            <SecretFieldRow
              title="访问令牌"
              prompt="默认：local_dev_token"
              value={localToken}
              onChanged={setLocalToken}
              revealed={showLocalToken}
              onToggle={() => setShowLocalToken(value => !value)}
            />
          </Section>
        ) : null}

        {mode !== "direct" ? (
          <Section
            header={<Text>Worker 配置</Text>}
            footer={<Text>请在 Cloudflare Workers 上部署代理服务，并将部署后的 URL 填在上方（不以斜杠结尾）。</Text>}
          >
            <TextField
              title="Worker 地址"
              prompt="https://your-worker.xxxx.workers.dev"
              value={workerUrl}
              onChanged={setWorkerUrl}
            />
            <SecretFieldRow
              title="访问令牌"
              prompt="填写 Worker AUTH_TOKEN"
              value={authToken}
              onChanged={setAuthToken}
              revealed={showAuthToken}
              onToggle={() => setShowAuthToken(value => !value)}
            />
            <TextField
              title="超时时间 (秒)"
              prompt="默认 45 秒"
              value={timeoutStr}
              onChanged={setTimeoutStr}
              keyboardType="numberPad"
            />
          </Section>
        ) : null}

      </List>
    </NavigationStack>
  )
}
