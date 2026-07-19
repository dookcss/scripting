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
  NavigationLink,
  useState,
  useEffect,
} from "scripting"
import {
  listAccounts,
  getActiveAccountId,
  setActiveAccountId,
  deleteAccount,
  getProxySettings,
} from "../storage"
import { AccountFormView } from "./AccountFormView"
import { ProxySettingsView } from "./ProxySettingsView"
import { AiSettingsView } from "./AiSettingsView"
import type { EmailAccount } from "../types"

export function AccountManageView() {
  const dismiss = Navigation.useDismiss()
  const [accounts, setAccounts] = useState<EmailAccount[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  // 代理检查
  const [proxyUrl, setProxyUrl] = useState("")
  const [aiModel, setAiModel] = useState("")

  const reloadData = () => {
    setAccounts(listAccounts())
    setActiveId(getActiveAccountId())
    const settings = getProxySettings()
    setProxyUrl(settings.workerUrl)
    setAiModel(settings.aiModel || "")
  }

  useEffect(() => {
    reloadData()
  }, [])

  const handleSelectActive = (id: string) => {
    setActiveAccountId(id)
    setActiveId(id)
  }

  const handleDelete = (id: string) => {
    Dialog.confirm({
      title: "删除账号",
      message: "确认删除此邮箱账号吗？此操作不可撤销。",
      confirmLabel: "删除",
      cancelLabel: "保留",
    }).then(confirmed => {
      if (confirmed) {
        deleteAccount(id)
        reloadData()
      }
    })
  }

  const openAddForm = () => {
    Navigation.present(
      <AccountFormView
        onSaved={() => {
          reloadData()
        }}
      />
    )
  }

  const openEditForm = (account: EmailAccount) => {
    Navigation.present(
      <AccountFormView
        account={account}
        onSaved={() => {
          reloadData()
        }}
      />
    )
  }

  const openProxySettings = () => {
    Navigation.present(<ProxySettingsView />).then(reloadData)
  }

  const openAiSettings = () => {
    Navigation.present(<AiSettingsView />).then(reloadData)
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="邮箱账号与设置"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="完成" action={dismiss} />,
          confirmationAction: (
            <Button
              title="添加账号"
              systemImage="plus"
              action={openAddForm}
            />
          ),
        }}
      >
        <Section header={<Text>服务与智能助理</Text>}>
          <HStack spacing={12} onTapGesture={openProxySettings}>
            <Image systemName="network" foregroundStyle="systemBlue" />
            <VStack alignment="leading" spacing={4}>
              <Text fontWeight="medium">邮件服务器与中转设置</Text>
              <Text font={13}>
                {proxyUrl ? `Worker: ${proxyUrl}` : "尚未设置 Worker 中转服务"}
              </Text>
            </VStack>
            <Image systemName="chevron.right" />
          </HStack>
          <HStack spacing={12} onTapGesture={openAiSettings}>
            <Image systemName="sparkles" foregroundStyle="systemPurple" />
            <VStack alignment="leading" spacing={4}>
              <Text fontWeight="medium">AI 智能助理设置</Text>
              <Text font={13}>
                {aiModel ? `当前模型: ${aiModel}` : "尚未配置 AI 模型"}
              </Text>
            </VStack>
            <Image systemName="chevron.right" />
          </HStack>
        </Section>

        <Section
          header={<Text>已绑定的邮箱账户</Text>}
          footer={<Text>选择一个账号作为主发送和收件默认账户。侧滑某一行可进行快捷编辑或删除。</Text>}
        >
          {accounts.length === 0 ? (
            <Text font={15}>暂无绑定的邮箱，请点击右上角「添加账号」</Text>
          ) : (
            accounts.map((acc: any) => {
              const isActive = acc.id === activeId
              return (
                <HStack
                  key={acc.id}
                  spacing={12}
                  trailingSwipeActions={{
                    allowsFullSwipe: false,
                    actions: [
                      <Button
                        title="编辑"
                        systemImage="pencil"
                        action={() => openEditForm(acc)}
                      />,
                      <Button
                        title="删除"
                        systemImage="trash"
                        role="destructive"
                        action={() => handleDelete(acc.id)}
                      />,
                    ],
                  }}
                >
                  <HStack spacing={8} onTapGesture={() => handleSelectActive(acc.id)}>
                    <Image
                      systemName={isActive ? "checkmark.circle.fill" : "circle"}
                    />
                    <VStack alignment="leading" spacing={4}>
                      <Text fontWeight="semibold">{acc.name}</Text>
                      <Text font={13}>
                        {acc.email} {acc.useProxy === true ? " (强制代理)" : acc.useProxy === false ? " (直连)" : ""}
                      </Text>
                    </VStack>
                  </HStack>
                </HStack>
              )
            })
          )}
        </Section>
      </List>
    </NavigationStack>
  )
}
