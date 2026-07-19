import {
  Navigation,
  NavigationStack,
  NavigationLink,
  List,
  Section,
  Button,
  Text,
  HStack,
  VStack,
  ZStack,
  Circle,
  Capsule,
  Image,
  Picker,
  ContentUnavailableView,
  Spacer,
  ProgressView,
  useState,
  useEffect,
} from "scripting"
import { listMessages, applyMailAction, listFolders, formatDateLabel, formatAddresses } from "../client"
import { getAccount, listAccounts } from "../storage"
import { MailDetailView } from "./MailDetailView"
import type { EmailAccount, MailMessageSummary, MailFolder } from "../types"

type MailListProps = {
  accountId: string
  onWriteMail: () => void
  onManageAccounts: () => void
}

export function MailListView({ accountId, onWriteMail, onManageAccounts }: MailListProps) {
  const account = getAccount(accountId)

  const [loading, setLoading] = useState(false)
  const [markingRead, setMarkingRead] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<MailMessageSummary[]>([])
  const [folders, setFolders] = useState<MailFolder[]>([])
  const [currentFolder, setCurrentFolder] = useState("INBOX")
  const [unseenOnly, setUnseenOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [searchText, setSearchText] = useState("")
  const [searchPresented, setSearchPresented] = useState(false)

  // 批量选择模式
  const [selectMode, setSelectMode] = useState(false)
  const [selectedUids, setSelectedUids] = useState<Set<number>>(new Set())

  // 左下角悬浮工具是否展开
  const [toolsExpanded, setToolsExpanded] = useState(false)

  // 避免分页过多，默认一页 30 封
  const pageSize = 30

  useEffect(() => {
    if (account) {
      setCurrentFolder("INBOX")
      setPage(1)
      setSearchText("")
      setSearchPresented(false)
      loadFolders()
      loadMailList(1, "INBOX", unseenOnly, "")
    } else {
      setMessages([])
      setFolders([])
    }
  }, [accountId])

  // 当搜索文本变化时进行 500ms 防抖搜索
  useEffect(() => {
    if (!account) return
    const handler = setTimeout(() => {
      loadMailList(1, currentFolder, unseenOnly, searchText)
    }, 500)
    return () => {
      clearTimeout(handler)
    }
  }, [searchText])

  const loadFolders = async () => {
    if (!account) return
    const res = await listFolders(account)
    if (res.ok) {
      setFolders(res.data)
    }
  }

  const loadMailList = async (targetPage: number, folderName: string, onlyUnseen: boolean, kw = searchText) => {
    if (!account) return
    setLoading(true)
    setError(null)
    const res = await listMessages(account, {
      folder: folderName,
      page: targetPage,
      pageSize,
      unseenOnly: onlyUnseen,
      keyword: kw || undefined,
    })

    if (res.ok) {
      if (targetPage === 1) {
        setMessages(res.data.messages)
      } else {
        setMessages((prev: any) => [...prev, ...res.data.messages])
      }
      setTotal(res.data.total)
      setPage(targetPage)
      setLoading(false)
    } else {
      setError(res.error)
      setLoading(false)
    }
  }

  const handleRefresh = async () => {
    await loadMailList(1, currentFolder, unseenOnly, searchText)
  }

  const handleLoadMore = () => {
    if (messages.length < total && !loading) {
      loadMailList(page + 1, currentFolder, unseenOnly, searchText)
    }
  }

  const handleToggleUnseenFilter = () => {
    const nextVal = !unseenOnly
    setUnseenOnly(nextVal)
    loadMailList(1, currentFolder, nextVal, searchText)
  }

  const handleMarkVisibleAsRead = async () => {
    if (!account || markingRead) return

    const unreadUids = messages
      .filter(message => !message.seen)
      .map(message => message.uid)
    if (unreadUids.length === 0) {
      Dialog.alert({ title: "提示", message: "当前列表中没有未读邮件" })
      return
    }

    setMarkingRead(true)
    const res = await applyMailAction(
      account,
      { type: "markSeen", uids: unreadUids, seen: true },
      currentFolder,
    )
    setMarkingRead(false)

    if (!res.ok) {
      Dialog.alert({ title: "标记失败", message: res.error })
      return
    }

    if (unseenOnly) {
      const unreadUidSet = new Set(unreadUids)
      setMessages(previous => previous.filter(message => !unreadUidSet.has(message.uid)))
      setTotal(previous => Math.max(0, previous - unreadUids.length))
    } else {
      const unreadUidSet = new Set(unreadUids)
      setMessages(previous => previous.map(message => (
        unreadUidSet.has(message.uid) ? { ...message, seen: true } : message
      )))
    }
    setToolsExpanded(false)
  }

  const handleFolderChange = (folderName: string) => {
    setCurrentFolder(folderName)
    loadMailList(1, folderName, unseenOnly, searchText)
  }

  const handleToggleSeen = async (msg: MailMessageSummary) => {
    if (!account) return
    const nextSeen = !msg.seen
    const res = await applyMailAction(account, { type: "markSeen", uids: [msg.uid], seen: nextSeen }, currentFolder)
    if (res.ok) {
      setMessages((prev: any) =>
        prev.map((item: any) => (item.uid === msg.uid ? { ...item, seen: nextSeen } : item))
      )
    }
  }

  const handleToggleFlagged = async (msg: MailMessageSummary) => {
    if (!account) return
    const nextFlagged = !msg.flagged
    const res = await applyMailAction(account, { type: "flag", uids: [msg.uid], flagged: nextFlagged }, currentFolder)
    if (res.ok) {
      setMessages((prev: any) =>
        prev.map((item: any) => (item.uid === msg.uid ? { ...item, flagged: nextFlagged } : item))
      )
    }
  }

  const handleDelete = async (uid: number) => {
    if (!account) return
    const res = await applyMailAction(account, { type: "delete", uids: [uid] }, currentFolder)
    if (res.ok) {
      setMessages((prev: any) => prev.filter((item: any) => item.uid !== uid))
      setTotal((prev: any) => Math.max(0, prev - 1))
    } else {
      Dialog.alert({ title: "删除失败", message: res.error })
    }
  }

  const toggleSelectMode = () => {
    if (selectMode) {
      setSelectMode(false)
      setSelectedUids(new Set())
    } else {
      setSelectMode(true)
      setSelectedUids(new Set())
    }
  }

  const toggleSelect = (uid: number) => {
    setSelectedUids((prev: Set<number>) => {
      const next = new Set(prev)
      if (next.has(uid)) {
        next.delete(uid)
      } else {
        next.add(uid)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    if (selectedUids.size === messages.length) {
      setSelectedUids(new Set())
    } else {
      setSelectedUids(new Set(messages.map((m: any) => m.uid)))
    }
  }

  const handleBatchMarkRead = async () => {
    if (!account || markingRead) return

    const unreadUids = messages
      .filter(message => selectedUids.has(message.uid) && !message.seen)
      .map(message => message.uid)
    if (unreadUids.length === 0) {
      Dialog.alert({ title: "提示", message: "选中的邮件均已是已读状态" })
      return
    }

    setMarkingRead(true)
    const res = await applyMailAction(
      account,
      { type: "markSeen", uids: unreadUids, seen: true },
      currentFolder,
    )
    setMarkingRead(false)

    if (!res.ok) {
      Dialog.alert({ title: "标记失败", message: res.error })
      return
    }

    const unreadUidSet = new Set(unreadUids)
    if (unseenOnly) {
      setMessages(previous => previous.filter(message => !unreadUidSet.has(message.uid)))
      setTotal(previous => Math.max(0, previous - unreadUids.length))
    } else {
      setMessages(previous => previous.map(message => (
        unreadUidSet.has(message.uid) ? { ...message, seen: true } : message
      )))
    }
    setSelectedUids(new Set())
    setSelectMode(false)
  }

  const handleBatchDelete = async () => {
    if (!account) return
    if (selectedUids.size === 0) {
      Dialog.alert({ title: "提示", message: "请先选择要删除的邮件" })
      return
    }
    const confirmed = await Dialog.confirm({
      title: "批量删除",
      message: `确认删除选中的 ${selectedUids.size} 封邮件？此操作不可撤销。`,
      confirmLabel: "删除",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    const uids = Array.from(selectedUids)
    const res = await applyMailAction(account, { type: "delete", uids }, currentFolder)
    if (res.ok) {
      setMessages((prev: any) => prev.filter((item: any) => !selectedUids.has(item.uid)))
      setTotal((prev: any) => Math.max(0, prev - uids.length))
      setSelectedUids(new Set())
      setSelectMode(false)
      handleRefresh()
    } else {
      Dialog.alert({ title: "删除失败", message: res.error })
    }
  }



  if (!account) {
    return (
      <ContentUnavailableView
        title="无邮箱账号"
        systemImage="envelope.badge.shield.halffilled"
        description="请前往右上角绑定你的第一个邮箱（例如 Gmail）。"
      />
    )
  }

  return (
    <List
      navigationTitle={selectMode ? `已选择 ${selectedUids.size} 封` : account.email}
      navigationBarTitleDisplayMode="inline"
      refreshable={handleRefresh}
      searchable={{
        prompt: "搜索发件人、主题或邮件内容",
        value: searchText,
        onChanged: (val: string) => setSearchText(val),
        presented: {
          value: searchPresented,
          onChanged: (val: boolean) => {
            setSearchPresented(val)
            if (!val) {
              setSearchText("")
            }
          }
        }
      }}
      toolbar={{
        confirmationAction: selectMode ? (
          <Button title="完成" action={toggleSelectMode} />
        ) : (
          <Button
            title="写信"
            systemImage="square.and.pencil"
            action={onWriteMail}
          />
        ),
      }}
      safeAreaInset={selectMode ? {
        bottom: {
          alignment: "center",
          spacing: 0,
          content: (
            <HStack
              padding={{ horizontal: 18, vertical: 12 }}
              frame={{ maxWidth: "infinity" }}
            >
              <Button action={handleSelectAll}>
                <ZStack>
                  <Circle
                    fill={selectedUids.size === messages.length && messages.length > 0 ? "systemBlue" : "systemGray4"}
                    frame={{ width: 52, height: 52 }}
                    shadow={{ color: "gray", radius: 8, x: 0, y: 3 }}
                  />
                  <Image
                    systemName={selectedUids.size === messages.length && messages.length > 0 ? "checkmark.circle.fill" : "checkmark.circle"}
                    font={22}
                    foregroundStyle="white"
                  />
                </ZStack>
              </Button>
              <Spacer />
              <Button
                action={handleBatchMarkRead}
                disabled={selectedUids.size === 0 || markingRead}
              >
                <ZStack>
                  <Circle
                    fill={selectedUids.size === 0 ? "systemGray4" : "systemBlue"}
                    frame={{ width: 52, height: 52 }}
                    shadow={{ color: "gray", radius: 8, x: 0, y: 3 }}
                  />
                  <VStack spacing={1}>
                    <Image
                      systemName={markingRead ? "hourglass" : "envelope.open.fill"}
                      font={18}
                      foregroundStyle="white"
                    />
                    <Text font={9} foregroundStyle="white">
                      {markingRead ? "处理中" : "已读"}
                    </Text>
                  </VStack>
                </ZStack>
              </Button>
              <Spacer />
              <Button
                action={handleBatchDelete}
                disabled={selectedUids.size === 0 || markingRead}
              >
                <ZStack>
                  <Circle
                    fill={selectedUids.size === 0 ? "systemGray4" : "systemRed"}
                    frame={{ width: 52, height: 52 }}
                    shadow={{ color: "gray", radius: 8, x: 0, y: 3 }}
                  />
                  <Image
                    systemName="trash.fill"
                    font={22}
                    foregroundStyle="white"
                  />
                </ZStack>
              </Button>
            </HStack>
          ),
        },
      } : {
        bottom: {
          alignment: "trailing",
          spacing: 0,
          content: (
            <HStack spacing={12} padding={{ horizontal: 18, vertical: 12 }}>
              {toolsExpanded ? (
                <ZStack>
                  <Capsule
                    fill="regularMaterial"
                    frame={{ height: 52 }}
                    shadow={{ color: "gray", radius: 8, x: 0, y: 3 }}
                  />
                  <HStack spacing={22} padding={{ horizontal: 22 }} frame={{ height: 52 }}>
                    <Button
                      action={() => {
                        handleToggleUnseenFilter()
                        setToolsExpanded(false)
                      }}
                    >
                      <VStack spacing={2}>
                        <Image
                          systemName={unseenOnly ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"}
                          font={20}
                          foregroundStyle={unseenOnly ? "systemBlue" : "label"}
                        />
                        <Text font={10} foregroundStyle={unseenOnly ? "systemBlue" : "secondaryLabel"}>
                          {unseenOnly ? "全部" : "未读"}
                        </Text>
                      </VStack>
                    </Button>
                    <Button
                      action={handleMarkVisibleAsRead}
                      disabled={markingRead || !messages.some(message => !message.seen)}
                    >
                      <VStack spacing={2}>
                        <Image
                          systemName={markingRead ? "hourglass" : "envelope.open"}
                          font={20}
                          foregroundStyle={markingRead ? "systemOrange" : "label"}
                        />
                        <Text font={10} foregroundStyle="secondaryLabel">
                          {markingRead ? "处理中" : "已读"}
                        </Text>
                      </VStack>
                    </Button>
                    <Button
                      action={() => {
                        toggleSelectMode()
                        setToolsExpanded(false)
                      }}
                    >
                      <VStack spacing={2}>
                        <Image systemName="checkmark.circle" font={20} foregroundStyle="label" />
                        <Text font={10} foregroundStyle="secondaryLabel">选择</Text>
                      </VStack>
                    </Button>
                  </HStack>
                </ZStack>
              ) : null}

              <Button action={() => setToolsExpanded((v: boolean) => !v)}>
                <ZStack>
                  <Circle
                    fill="regularMaterial"
                    frame={{ width: 52, height: 52 }}
                    shadow={{ color: "gray", radius: 8, x: 0, y: 3 }}
                  />
                  <Image
                    systemName={toolsExpanded ? "xmark" : "slider.horizontal.3"}
                    font={20}
                    foregroundStyle="systemBlue"
                  />
                </ZStack>
              </Button>
            </HStack>
          ),
        },
      }}
    >
      {/* 文件夹及过滤器选择区 */}
      <Section>
        <HStack spacing={12}>
          <Text fontWeight="semibold" font={17}>文件夹:</Text>
          <Picker
            title="选择文件夹"
            value={currentFolder}
            onChanged={handleFolderChange}
          >
            {folders.length === 0 ? (
              <Text tag="INBOX">收件箱 (INBOX)</Text>
            ) : (
              folders.map((f: any) => {
                const localizeFolderName = (rawName: string) => {
                  const decodeImapUtf7 = (str: string) => {
                    return str.replace(/&([^-]*)-/g, (match, base64) => {
                      if (base64 === '') return '&';
                      const b64Str = base64.replace(/,/g, '/');
                      try {
                        const decodedBytes = atob(b64Str);
                        let res = '';
                        for (let i = 0; i < decodedBytes.length; i += 2) {
                          res += String.fromCharCode((decodedBytes.charCodeAt(i) << 8) | decodedBytes.charCodeAt(i + 1));
                        }
                        return res;
                      } catch (e) {
                        return match;
                      }
                    });
                  };
                  const name = decodeImapUtf7(rawName);
                  const map: Record<string, string> = {
                    "INBOX": "收件箱",
                    "[Gmail]/所有邮件": "所有邮件",
                    "[Gmail]/All Mail": "所有邮件",
                    "[Gmail]/已发送邮件": "已发送",
                    "[Gmail]/Sent Mail": "已发送",
                    "[Gmail]/垃圾邮件": "垃圾邮件",
                    "[Gmail]/Spam": "垃圾邮件",
                    "[Gmail]/草稿": "草稿箱",
                    "[Gmail]/Drafts": "草稿箱",
                    "[Gmail]/已删除邮件": "垃圾桶",
                    "[Gmail]/Trash": "垃圾桶",
                    "[Gmail]/重要": "重要邮件",
                    "[Gmail]/Important": "重要邮件",
                    "[Gmail]/星标": "星标邮件",
                    "[Gmail]/Starred": "星标邮件",
                    "Sent": "已发送",
                    "Trash": "垃圾桶",
                    "Drafts": "草稿箱",
                    "Junk": "垃圾邮件",
                    "Archive": "归档",
                  }
                  return map[name] || name.replace(/^\[Gmail\]\//, "")
                }
                return (
                  <Text tag={f.name} key={f.name}>
                    {localizeFolderName(f.name)}
                  </Text>
                )
              })
            )}
          </Picker>
        </HStack>
      </Section>

      {/* 异常及加载态展示 */}
      {error ? (
        <Section>
          <VStack alignment="center" spacing={12} padding={16}>
            <Image systemName="exclamationmark.triangle" font={28} foregroundStyle="red" />
            <Text fontWeight="semibold">邮件加载失败</Text>
            <Text font={14} multilineTextAlignment="center">
              {error}
            </Text>
            <Button title="重试" action={handleRefresh} />
          </VStack>
        </Section>
      ) : null}

      {/* 邮件数据渲染列表 */}
      <Section
        header={
          <HStack>
            <Text font={13}>
              共 {total} 封邮件 {unseenOnly ? " (未读)" : ""}
            </Text>
            {loading ? (
              <HStack spacing={4}>
                <ProgressView />
                <Text font={12} foregroundStyle="tertiaryLabel">同步中</Text>
              </HStack>
            ) : null}
          </HStack>
        }
      >
        {messages.length === 0 && !loading && !error ? (
          <Text font={15}>
            此文件夹下没有邮件。
          </Text>
        ) : (
          messages.map((msg: any) => {
            const mailRow = (
              <HStack spacing={10}>
                {/* 选择模式下显示勾选图标 */}
                {selectMode ? (
                  <Image
                    systemName={selectedUids.has(msg.uid) ? "checkmark.circle.fill" : "circle"}
                    font={22}
                    foregroundStyle={selectedUids.has(msg.uid) ? "systemBlue" : "tertiaryLabel"}
                  />
                ) : (
                  <VStack alignment="center" frame={{ width: 8 }}>
                    {!msg.seen ? (
                      <Image
                        systemName="circle.fill"
                        font={8}
                        foregroundStyle="blue"
                      />
                    ) : null}
                  </VStack>
                )}

                <VStack alignment="leading" spacing={4}>
                  <HStack>
                    <Text fontWeight={msg.seen ? "medium" : "bold"} font={15}>
                      {msg.from?.[0]?.name || msg.from?.[0]?.address || "(无发件人)"}
                    </Text>
                    <Text font={13}>
                      {formatDateLabel(msg.date)}
                    </Text>
                  </HStack>

                  <HStack>
                    <Text
                      fontWeight={msg.seen ? "regular" : "semibold"}
                      font={14}
                      lineLimit={1}
                    >
                      {msg.subject || "(无主题)"}
                    </Text>
                    {msg.flagged ? (
                      <Image systemName="star.fill" font={12} foregroundStyle="orange" />
                    ) : null}
                    {msg.hasAttachment ? (
                      <Image systemName="paperclip" font={12} />
                    ) : null}
                  </HStack>

                  <Text font={13} lineLimit={2}>
                    {msg.snippet || "(无正文预览)"}
                  </Text>
                </VStack>
              </HStack>
            )

            if (selectMode) {
              return (
                <Button
                  key={`${msg.uid}-${msg.seq}`}
                  action={() => toggleSelect(msg.uid)}
                >
                  {mailRow}
                </Button>
              )
            }

            return (
              <NavigationLink
                key={`${msg.uid}-${msg.seq}`}
                destination={
                  <MailDetailView
                    account={account}
                    uid={msg.uid}
                    folder={currentFolder}
                    onActionComplete={handleRefresh}
                  />
                }
              >
                <HStack
                  spacing={0}
                  trailingSwipeActions={{
                    allowsFullSwipe: false,
                    actions: [
                      <Button
                        title={msg.seen ? "标记未读" : "标记已读"}
                        systemImage={msg.seen ? "envelope.badge" : "envelope.open"}
                        action={() => handleToggleSeen(msg)}
                      />,
                      <Button
                        title={msg.flagged ? "取消星标" : "标记星标"}
                        systemImage={msg.flagged ? "star.slash" : "star"}
                        action={() => handleToggleFlagged(msg)}
                      />,
                      <Button
                        title="删除"
                        systemImage="trash"
                        role="destructive"
                        action={() => handleDelete(msg.uid)}
                      />,
                    ],
                  }}
                >
                  {mailRow}
                </HStack>
              </NavigationLink>
            )
          })
        )}
      </Section>

      {/* 加载更多 */}
      {messages.length < total && !loading && !error ? (
        <Section>
          <Button title="加载更多..." action={handleLoadMore} />
        </Section>
      ) : null}
    </List>
  )
}
