import {
  Script,
  Navigation,
  NavigationStack,
  NavigationLink,
  List,
  Section,
  Button,
  Text,
  HStack,
  VStack,
  Image,
  useState,
  useEffect,
} from "scripting"
import { listAccounts } from "./storage"
import { MailListView } from "./views/MailListView"
import { MailComposeView } from "./views/MailComposeView"
import { AccountManageView } from "./views/AccountManageView"
import { UsageNoticeView } from "./views/UsageNoticeView"
import type { EmailAccount } from "./types"

function EmailToolsApp() {
  const dismiss = Navigation.useDismiss()
  const [accounts, setAccounts] = useState<EmailAccount[]>([])

  const reloadAccounts = () => {
    const list = listAccounts()
    setAccounts(list)
  }

  useEffect(() => {
    reloadAccounts()
  }, [])

  const openAccountManage = () => {
    Navigation.present(<AccountManageView />).then(() => {
      reloadAccounts()
    })
  }

  const showUsageNotice = () => {
    Navigation.present({
      element: <UsageNoticeView />,
      modalPresentationStyle: "fullScreen",
    })
  }

  const openComposeForAccount = (accountId: string) => {
    Navigation.present({
      element: <MailComposeView accountId={accountId} />,
      modalPresentationStyle: "fullScreen",
    })
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="邮箱工具"
        navigationBarTitleDisplayMode="large"
        toolbar={{
          cancellationAction: <Button title="退出" action={dismiss} />,
          confirmationAction: (
            <HStack spacing={16}>
              <Button
                title="使用提示"
                systemImage="info.circle"
                action={showUsageNotice}
              />
              <Button
                title="添加/管理账号"
                systemImage="gear"
                action={openAccountManage}
              />
            </HStack>
          ),
        }}
      >
        <Section header={<Text>所有邮箱</Text>}>
          {accounts.length === 0 ? (
            <HStack spacing={12} onTapGesture={openAccountManage}>
              <VStack alignment="leading" spacing={4}>
                <Text fontWeight="semibold" foregroundStyle="systemBlue">未绑定邮箱账号</Text>
                <Text font={13}>
                  点击这里前往添加你的第一个邮箱（支持 Gmail/Outlook/QQ等）
                </Text>
              </VStack>
              <Image systemName="chevron.right" />
            </HStack>
          ) : (
            accounts.map((acc: any) => (
              <NavigationLink
                key={acc.id}
                destination={
                  <MailListView
                    accountId={acc.id}
                    onWriteMail={() => openComposeForAccount(acc.id)}
                    onManageAccounts={openAccountManage}
                  />
                }
              >
                <HStack spacing={12} padding={{ vertical: 4 }}>
                  <Image systemName="envelope.fill" foregroundStyle="systemBlue" font={24} />
                  <VStack alignment="leading" spacing={4}>
                    <Text fontWeight="semibold">{acc.name}</Text>
                    <Text font={13} foregroundStyle="gray">{acc.email}</Text>
                  </VStack>
                </HStack>
              </NavigationLink>
            ))
          )}
        </Section>
      </List>
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present({
    element: <EmailToolsApp />,
    modalPresentationStyle: "fullScreen"
  })

  Script.exit()
}

run()

