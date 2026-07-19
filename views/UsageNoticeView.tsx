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
} from "scripting"

export function UsageNoticeView() {
  const dismiss = Navigation.useDismiss()

  return (
    <NavigationStack>
      <List
        navigationTitle="使用与部署提示"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          confirmationAction: <Button title="完成" action={dismiss} />,
        }}
      >
        <Section>
          <HStack spacing={12} padding={{ vertical: 6 }}>
            <Image systemName="info.circle.fill" font={24} foregroundStyle="systemBlue" />
            <Text font={15}>
              本工具仅提供邮件客户端能力，不提供公共邮件中转服务器。使用前请根据邮箱类型自行部署并配置服务。
            </Text>
          </HStack>
        </Section>

        <Section header={<Text>国外邮箱</Text>}>
          <VStack alignment="leading" spacing={8} padding={{ vertical: 6 }}>
            <HStack spacing={8}>
              <Image systemName="cloud.fill" foregroundStyle="systemBlue" />
              <Text fontWeight="semibold">Cloudflare Worker</Text>
            </HStack>
            <Text font={14}>
              Gmail、Outlook、iCloud 等国外邮箱，建议自行部署项目 worker 目录中的 Cloudflare Worker。
            </Text>
            <Text font={14}>
              部署后，请在“邮件服务器与中转设置”中填写 Worker 地址，以及与服务端一致的 AUTH_TOKEN。
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>国内邮箱</Text>}>
          <VStack alignment="leading" spacing={8} padding={{ vertical: 6 }}>
            <HStack spacing={8}>
              <Image systemName="desktopcomputer" foregroundStyle="systemGreen" />
              <Text fontWeight="semibold">本地 Server</Text>
            </HStack>
            <Text font={14}>
              QQ、163 等国内邮箱，请在可信电脑或服务器上运行 domestic_server/index.js。
            </Text>
            <Text font={14}>
              在设置中填写电脑的局域网 Server 地址及一致的 AUTH_TOKEN。默认监听端口为 18000。
            </Text>
          </VStack>
        </Section>

        <Section
          header={<Text>IMAP / SMTP 配置</Text>}
          footer={<Text>若连接失败，请先确认邮箱后台已开启 IMAP/SMTP 服务，并使用应用专用密码或授权码。SMTP 465 使用 SSL，587 通常使用 STARTTLS。</Text>}
        >
          <VStack alignment="leading" spacing={8} padding={{ vertical: 6 }}>
            <HStack spacing={8}>
              <Image systemName="tray.and.arrow.down.fill" foregroundStyle="systemBlue" />
              <Text fontWeight="semibold">IMAP：接收与管理邮件</Text>
            </HStack>
            <Text font={14}>
              IMAP 用于读取文件夹和邮件，并同步已读、星标、移动及删除状态。常用安全端口为 993，需开启 SSL。
            </Text>
          </VStack>
          <VStack alignment="leading" spacing={8} padding={{ vertical: 6 }}>
            <HStack spacing={8}>
              <Image systemName="paperplane.fill" foregroundStyle="systemGreen" />
              <Text fontWeight="semibold">SMTP：发送邮件</Text>
            </HStack>
            <Text font={14}>
              SMTP 用于发送邮件。端口 465 通常直接使用 SSL；端口 587 通常先建立连接，再通过 STARTTLS 升级加密。
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>常用服务器参数</Text>}>
          <VStack alignment="leading" spacing={5} padding={{ vertical: 4 }}>
            <Text fontWeight="semibold">Gmail</Text>
            <Text font={13}>IMAP：imap.gmail.com · 993 · SSL</Text>
            <Text font={13}>SMTP：smtp.gmail.com · 465 · SSL</Text>
          </VStack>
          <VStack alignment="leading" spacing={5} padding={{ vertical: 4 }}>
            <Text fontWeight="semibold">Outlook / Hotmail</Text>
            <Text font={13}>IMAP：outlook.office365.com · 993 · SSL</Text>
            <Text font={13}>SMTP：smtp.office365.com · 587 · STARTTLS</Text>
          </VStack>
          <VStack alignment="leading" spacing={5} padding={{ vertical: 4 }}>
            <Text fontWeight="semibold">iCloud 邮箱</Text>
            <Text font={13}>IMAP：imap.mail.me.com · 993 · SSL</Text>
            <Text font={13}>SMTP：smtp.mail.me.com · 587 · STARTTLS</Text>
          </VStack>
          <VStack alignment="leading" spacing={5} padding={{ vertical: 4 }}>
            <Text fontWeight="semibold">QQ 邮箱</Text>
            <Text font={13}>IMAP：imap.qq.com · 993 · SSL</Text>
            <Text font={13}>SMTP：smtp.qq.com · 465 · SSL</Text>
          </VStack>
          <VStack alignment="leading" spacing={5} padding={{ vertical: 4 }}>
            <Text fontWeight="semibold">网易 163 / 126</Text>
            <Text font={13}>IMAP：imap.163.com · 993 · SSL</Text>
            <Text font={13}>SMTP：smtp.163.com · 465 · SSL</Text>
          </VStack>
        </Section>

        <Section
          header={<Text>邮箱凭证与快捷入口</Text>}
          footer={<Text>应用专用密码通常需要先开启两步验证。部分组织账户可能由管理员禁用该功能。</Text>}
        >
          <HStack spacing={12} padding={{ vertical: 6 }}>
            <Image systemName="key.fill" foregroundStyle="systemOrange" />
            <Text font={14}>
              邮箱登录通常需要应用专用密码或授权码，请勿直接填写账号登录密码。
            </Text>
          </HStack>
          <Button
            title="生成 Google 应用专用密码"
            systemImage="safari"
            action={async () => {
              const opened = await Safari.openURL("https://myaccount.google.com/apppasswords")
              if (!opened) {
                Dialog.alert({ title: "打开失败", message: "无法打开 Google 应用专用密码页面" })
              }
            }}
          />
          <Button
            title="打开 Microsoft 应用密码设置"
            systemImage="safari"
            action={async () => {
              const opened = await Safari.openURL("https://account.live.com/proofs/manage/additional")
              if (!opened) {
                Dialog.alert({ title: "打开失败", message: "无法打开 Microsoft 高级安全设置页面" })
              }
            }}
          />
        </Section>

        <Section header={<Text>AI 智能助理</Text>}>
          <HStack spacing={12} padding={{ vertical: 6 }}>
            <Image systemName="sparkles" foregroundStyle="systemPurple" />
            <Text font={14}>
              AI 总结、翻译和写作功能需要自行配置 OpenAI 兼容接口。邮件内容会发送至你配置的 AI 服务，请事先确认其隐私与安全性。
            </Text>
          </HStack>
        </Section>

        <Section header={<Text>安全提醒</Text>}>
          <HStack spacing={12} padding={{ vertical: 6 }}>
            <Image systemName="exclamationmark.shield.fill" foregroundStyle="systemRed" />
            <Text font={14}>
              请勿将未启用 HTTPS、使用弱令牌或默认令牌的中转服务直接暴露到公网。
            </Text>
          </HStack>
        </Section>
      </List>
    </NavigationStack>
  )
}
