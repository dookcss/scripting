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
  Toggle,
  useState,
} from "scripting"
import { getPreset, PROVIDER_PRESETS, guessProviderByEmail } from "../presets"
import { upsertAccount, getAccountPassword } from "../storage"
import { testAccountConnection } from "../client"
import type { EmailAccount, EmailProviderId } from "../types"

type AccountFormProps = {
  account?: EmailAccount | null
  onSaved: (account: EmailAccount) => void
}

export function AccountFormView({ account, onSaved }: AccountFormProps) {
  const dismiss = Navigation.useDismiss()
  const isEdit = !!account

  const [name, setName] = useState(account?.name ?? "")
  const [email, setEmail] = useState(account?.email ?? "")
  const [providerId, setProviderId] = useState<EmailProviderId>(account?.providerId ?? "gmail")
  const [imapHost, setImapHost] = useState(account?.imapHost ?? "imap.gmail.com")
  const [imapPort, setImapPort] = useState(String(account?.imapPort ?? 993))
  const [imapSecure, setImapSecure] = useState(account?.imapSecure ?? true)
  const [smtpHost, setSmtpHost] = useState(account?.smtpHost ?? "smtp.gmail.com")
  const [smtpPort, setSmtpPort] = useState(String(account?.smtpPort ?? 465))
  const [smtpSecure, setSmtpSecure] = useState(account?.smtpSecure ?? true)
  const [smtpStartTLS, setSmtpStartTLS] = useState(account?.smtpStartTLS ?? false)
  const [username, setUsername] = useState(account?.username ?? "")
  const [password, setPassword] = useState(isEdit ? (getAccountPassword(account!.id) || "") : "")
  const [useProxy, setUseProxy] = useState<"auto" | "proxy" | "direct">(
    account ? (account.useProxy === null ? "auto" : account.useProxy ? "proxy" : "direct") : "auto"
  )

  const [showPassword, setShowPassword] = useState(false)
  const [testing, setTesting] = useState(false)

  const applyPreset = (pid: EmailProviderId) => {
    setProviderId(pid)
    const preset = getPreset(pid)
    if (pid !== "custom") {
      setImapHost(preset.imapHost)
      setImapPort(String(preset.imapPort))
      setImapSecure(preset.imapSecure)
      setSmtpHost(preset.smtpHost)
      setSmtpPort(String(preset.smtpPort))
      setSmtpSecure(preset.smtpSecure)
      setSmtpStartTLS(preset.smtpStartTLS)
    }
  }

  const handleEmailChange = (val: string) => {
    setEmail(val)
    if (!isEdit) {
      const preset = guessProviderByEmail(val)
      if (preset.id !== "custom" && preset.id !== providerId) {
        applyPreset(preset.id)
      }
    }
  }

  // 校验及连接测试
  const validateAndSave = async (onlyTest = false) => {
    if (!email.includes("@")) {
      Dialog.alert({ title: "提示", message: "请输入有效的邮箱地址" })
      return null
    }

    const finalImapHost = imapHost.trim()
    const finalSmtpHost = smtpHost.trim()
    const finalImapPort = parseInt(imapPort, 10)
    const finalSmtpPort = parseInt(smtpPort, 10)

    if (!finalImapHost || !finalSmtpHost || Number.isNaN(finalImapPort) || Number.isNaN(finalSmtpPort)) {
      Dialog.alert({ title: "提示", message: "请补全 IMAP/SMTP 主机及端口配置" })
      return null
    }

    const finalPassword = password
    if (!finalPassword) {
      Dialog.alert({ title: "提示", message: "密码或授权码不能为空" })
      return null
    }

    const payload: Omit<EmailAccount, "id" | "createdAt" | "updatedAt"> & {
      id?: string
      password?: string
    } = {
        id: account?.id,
        name: name.trim() || email.trim(),
        email: email.trim(),
        providerId,
        imapHost: finalImapHost,
        imapPort: finalImapPort,
        imapSecure,
        smtpHost: finalSmtpHost,
        smtpPort: finalSmtpPort,
        smtpSecure,
        smtpStartTLS,
        username: username.trim() || email.trim(),
        useProxy: useProxy === "auto" ? null : useProxy === "proxy",
        password: finalPassword,
      }

    if (onlyTest) {
      setTesting(true)
      // 临时组装伪账号对象做连通性测试
      const testObj: EmailAccount = {
        id: account?.id || "temp",
        createdAt: 0,
        updatedAt: 0,
        ...payload,
      }
      const res = await testAccountConnection(testObj, finalPassword)
      setTesting(false)
      if (res.ok) {
        Dialog.alert({
          title: "连接成功",
          message: `登录成功！收件箱共有 ${res.data.exists} 封邮件。`,
        })
      } else {
        Dialog.alert({
          title: "连接失败",
          message: res.error || "未知连接错误",
        })
      }
      return null
    }

    const saved = upsertAccount(payload)
    onSaved(saved)
    dismiss()
    return saved
  }

  return (
    <NavigationStack>
      <List
        navigationTitle={isEdit ? "编辑邮箱账号" : "添加邮箱账号"}
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="取消" action={dismiss} />,
          confirmationAction: <Button title="完成" action={() => validateAndSave(false)} />,
        }}
      >
        <Section header={<Text>基本信息</Text>}>
          <TextField title="邮箱地址" prompt="example@gmail.com" value={email} onChanged={handleEmailChange} />
          {showPassword
            ? <TextField title="密码 / 授权码" prompt={isEdit ? "留空表示不修改" : "输入密码或专用授权码"} value={password} onChanged={setPassword} />
            : <SecureField title="密码 / 授权码" prompt={isEdit ? "留空表示不修改" : "输入密码或专用授权码"} value={password} onChanged={setPassword} />
          }
          <Toggle title="显示密码" value={showPassword} onChanged={setShowPassword} />
          <TextField title="备注名称" prompt="例如：我的 Gmail" value={name} onChanged={setName} />
        </Section>

        <Section header={<Text>邮箱服务商</Text>}>
          <Picker title="服务商预设" value={providerId} onChanged={(val: any) => applyPreset(val)}>
            {PROVIDER_PRESETS.map((preset: any) => (
              <Text tag={preset.id} key={preset.id}>{preset.name}</Text>
            ))}
          </Picker>
          <Text font={14}>
            {getPreset(providerId).hint}
          </Text>
        </Section>

        <Section header={<Text>连接参数（IMAP收信 / SMTP发信）</Text>}>
          <TextField title="IMAP 主机" prompt="imap.xxx.com" value={imapHost} onChanged={setImapHost} />
          <TextField title="IMAP 端口" prompt="993" value={imapPort} onChanged={setImapPort} keyboardType="numberPad" />
          <Toggle title="IMAP SSL 安全连接" value={imapSecure} onChanged={setImapSecure} />

          <TextField title="SMTP 主机" prompt="smtp.xxx.com" value={smtpHost} onChanged={setSmtpHost} />
          <TextField title="SMTP 端口" prompt="465 / 587" value={smtpPort} onChanged={setSmtpPort} keyboardType="numberPad" />
          <Toggle title="SMTP SSL 安全连接" value={smtpSecure} onChanged={setSmtpSecure} />
          <Toggle title="SMTP STARTTLS 升级" value={smtpStartTLS} onChanged={setSmtpStartTLS} />

          <TextField title="登录用户名" prompt="留空默认使用邮箱地址" value={username} onChanged={setUsername} />
        </Section>

        <Section header={<Text>中转及网络设置</Text>}>
          <Picker title="网络通道" value={useProxy} onChanged={(val: any) => setUseProxy(val)}>
            <Text tag="auto">跟随全局自动模式</Text>
            <Text tag="proxy">强制走 CF Worker 中转</Text>
            <Text tag="direct">强制设备直连</Text>
          </Picker>
        </Section>

        <Section>
          <Button
            title={testing ? "正在测试连通性..." : "测试连接并登录"}
            action={() => validateAndSave(true)}
            disabled={testing}
          />
        </Section>
      </List>
    </NavigationStack>
  )
}
