/// <reference types="@cloudflare/workers-types" />
import { connect } from 'cloudflare:sockets';

export interface Env {
  AUTH_TOKEN: string;
}

// 统一的 API 响应格式
const jsonResponse = (data: any, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    },
  });
};

const corsResponse = () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    },
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsResponse();
    }

    // 校验 Authorization Token
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!env.AUTH_TOKEN) {
      return jsonResponse({ ok: false, error: 'Worker AUTH_TOKEN secret is not set' }, 500);
    }

    if (token !== env.AUTH_TOKEN) {
      return jsonResponse({ ok: false, error: 'Unauthorized: Invalid Auth Token' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const body = await request.json() as any;
      const connInfo = body.connection;

      if (!connInfo || !connInfo.email || !connInfo.password) {
        return jsonResponse({ ok: false, error: 'Missing connection details or password' }, 400);
      }

      if (path === '/v1/test') {
        const result = await testConnection(connInfo);
        return jsonResponse({ ok: true, data: result });
      }

      if (path === '/v1/folders') {
        const folders = await getFolders(connInfo);
        return jsonResponse({ ok: true, data: folders });
      }

      if (path === '/v1/messages') {
        const folder = body.folder || 'INBOX';
        const page = body.page || 1;
        const pageSize = body.pageSize || 20;
        const unseenOnly = !!body.unseenOnly;
        const keyword = body.keyword || '';
        const result = await fetchMessages(connInfo, folder, page, pageSize, unseenOnly, keyword);
        return jsonResponse({ ok: true, data: result });
      }

      if (path === '/v1/message') {
        const folder = body.folder || 'INBOX';
        const uid = parseInt(body.uid);
        if (isNaN(uid)) {
          return jsonResponse({ ok: false, error: 'Invalid UID' }, 400);
        }
        const message = await fetchMessageDetail(connInfo, folder, uid);
        return jsonResponse({ ok: true, data: message });
      }

      if (path === '/v1/send') {
        const mail = body.mail;
        if (!mail || !mail.to || !mail.subject) {
          return jsonResponse({ ok: false, error: 'Missing mail headers (to, subject)' }, 400);
        }
        const result = await sendEmail(connInfo, mail);
        return jsonResponse({ ok: true, data: result });
      }

      if (path === '/v1/action') {
        const folder = body.folder || 'INBOX';
        const action = body.action;
        if (!action || !action.type || !action.uids) {
          return jsonResponse({ ok: false, error: 'Invalid action parameters' }, 400);
        }
        const result = await applyMailAction(connInfo, folder, action);
        return jsonResponse({ ok: true, data: result });
      }

      return jsonResponse({ ok: false, error: 'Not Found' }, 404);
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error('Worker request failed', { path, errorName });
      return jsonResponse({
        ok: false,
        error: '邮件中转服务内部错误，请稍后重试',
        code: 'internal_error',
      }, 500);
    }
  },
};

// ==========================================
// Socket 通信助手：处理原生 IMAP 和 SMTP 行
// ==========================================

class SocketHelper {
  private socket: any;
  private writer: WritableStreamDefaultWriter<any>;
  private reader: ReadableStreamDefaultReader<any>;
  private decoder = new TextDecoder('utf-8');
  private buffer = '';

  constructor(host: string, port: number | string, useTls: boolean | string) {
    const numPort = Number(port);
    const isTls = String(useTls) === 'true' || numPort === 993 || numPort === 465;
    console.log(`Socket connecting to ${host}:${numPort} (TLS: ${isTls})`);
    
    // connect() 是 Cloudflare Workers 提供的主动连接 TCP 方法
    this.socket = connect(
      { hostname: String(host).trim(), port: numPort },
      isTls ? { secureTransport: 'on', allowHalfOpen: false } : { allowHalfOpen: false }
    );
    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();
  }

  async write(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.writer.write(bytes);
  }

  // 读取直到某行结束，或者读取指定长度
  async readLine(): Promise<string> {
    while (!this.buffer.includes('\n')) {
      const { value, done } = await this.reader.read();
      if (done) {
        if (this.buffer) {
          const line = this.buffer;
          this.buffer = '';
          return line;
        }
        throw new Error('Socket closed prematurely');
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    const idx = this.buffer.indexOf('\n');
    const line = this.buffer.substring(0, idx + 1);
    this.buffer = this.buffer.substring(idx + 1);
    return line;
  }

  // 连带 TLS 的升级 (用于 STARTTLS)
  startTls() {
    this.writer.releaseLock();
    this.reader.releaseLock();
    const secureSocket = this.socket.startTls();
    this.socket = secureSocket;
    this.writer = secureSocket.writable.getWriter();
    this.reader = secureSocket.readable.getReader();
  }

  async close() {
    try {
      this.writer.releaseLock();
      this.reader.releaseLock();
      await this.socket.close();
    } catch {}
  }

  // 读直到 IMAP 标签返回或特定的多行数据
  async readImapResponse(tag: string): Promise<string[]> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (line.startsWith(tag + ' ')) {
        break;
      }
    }
    return lines;
  }

  // 读直到 SMTP 状态行返回
  async readSmtpResponse(): Promise<string> {
    let result = '';
    while (true) {
      const line = await this.readLine();
      result += line;
      // SMTP 响应格式：三位数字加空格表示最后一行（例如 "250 Ok"），如果是 "-" 则表示还有后续行（例如 "250-8bitmime"）
      if (line.length >= 4 && line[3] === ' ') {
        break;
      }
    }
    return result;
  }
}

// ==========================================
// IMAP 协议封装
// ==========================================

async function executeImap<T>(
  conn: any,
  fn: (helper: SocketHelper) => Promise<T>
): Promise<T> {
  const helper = new SocketHelper(conn.imapHost, conn.imapPort, conn.imapSecure);
  try {
    // 1. 等待服务器 OK
    const banner = await helper.readLine();
    if (!banner.includes('OK')) {
      throw new Error('IMAP connection banner failed: ' + banner);
    }

    // 2. 登录
    const loginTag = 'A1';
    // 特别转义密码中的特殊字符（IMAP 中以双引号包裹，并转义反斜杠和双引号）
    const safeUser = escapeString(conn.username || conn.email);
    const safePass = escapeString(conn.password);
    await helper.write(`${loginTag} LOGIN "${safeUser}" "${safePass}"\r\n`);
    
    const loginResp = await helper.readImapResponse(loginTag);
    const lastLine = loginResp[loginResp.length - 1];
    if (!lastLine.includes(' OK')) {
      throw new Error('IMAP Login failed: ' + lastLine);
    }

    // 发送 ID 命令以绕过网易等国内邮箱的 "Unsafe Login" 拦截限制
    try {
      const idTag = 'A_ID';
      await helper.write(`${idTag} ID ("name" "iPhone" "version" "14.4" "vendor" "apple")\r\n`);
      await helper.readImapResponse(idTag);
    } catch (e: any) {
      console.log('IMAP ID command failed or not supported:', e.message);
    }

    return await fn(helper);
  } finally {
    try {
      await helper.write('A999 LOGOUT\r\n');
    } catch {}
    await helper.close();
  }
}

function escapeString(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 简单的连接测试
async function testConnection(conn: any) {
  return executeImap(conn, async (helper) => {
    // SELECT INBOX
    const tag = 'A2';
    await helper.write(`${tag} SELECT "INBOX"\r\n`);
    const resp = await helper.readImapResponse(tag);
    const lastLine = resp[resp.length - 1];
    if (!lastLine.includes(' OK')) {
      throw new Error('Select INBOX failed: ' + lastLine);
    }

    // 解析 EXISTS 数量
    let exists = 0;
    for (const line of resp) {
      const match = line.match(/\*\s+(\d+)\s+EXISTS/i);
      if (match) {
        exists = parseInt(match[1]);
      }
    }

    return { folder: 'INBOX', exists };
  });
}

// 文件夹列表
async function getFolders(conn: any) {
  return executeImap(conn, async (helper) => {
    const tag = 'A2';
    await helper.write(`${tag} LIST "" "*"\r\n`);
    const resp = await helper.readImapResponse(tag);
    
    const folders: any[] = [];
    for (const line of resp) {
      // 格式：* LIST (\HasNoChildren) "/" "INBOX"
      const match = line.match(/\*\s+LIST\s+\((.*?)\)\s+"(.*?)"\s+"(.*?)"/i);
      if (match) {
        folders.push({
          flags: match[1].split(' ').map(f => f.trim()),
          delimiter: match[2],
          name: unescapeImapFolderName(match[3]),
        });
      } else {
        // 部分服务器没有引号包围
        const simpleMatch = line.match(/\*\s+LIST\s+\((.*?)\)\s+([^\s]+)\s+([^\s]+)/i);
        if (simpleMatch) {
          folders.push({
            flags: simpleMatch[1].split(' ').map(f => f.trim()),
            delimiter: simpleMatch[2],
            name: unescapeImapFolderName(simpleMatch[3]),
          });
        }
      }
    }
    return folders;
  });
}

function unescapeImapFolderName(name: string): string {
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  return name.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// 分页列表获取
async function fetchMessages(
  conn: any,
  folder: string,
  page: number,
  pageSize: number,
  unseenOnly: boolean,
  keyword?: string
) {
  return executeImap(conn, async (helper) => {
    // 1. SELECT 目标文件夹
    const selectTag = 'A2';
    await helper.write(`${selectTag} SELECT "${escapeString(folder)}"\r\n`);
    const selectResp = await helper.readImapResponse(selectTag);
    const lastSelect = selectResp[selectResp.length - 1];
    if (!lastSelect.includes(' OK')) {
      throw new Error(`Select folder ${folder} failed: ${lastSelect}`);
    }

    let exists = 0;
    for (const line of selectResp) {
      const match = line.match(/\*\s+(\d+)\s+EXISTS/i);
      if (match) exists = parseInt(match[1]);
    }

    if (exists === 0) {
      return { folder, total: 0, page, pageSize, messages: [] };
    }

    // 2. 搜索或按序号确定取值范围
    let sequenceRange = '';
    let totalCount = exists;
    const useSearch = unseenOnly || !!keyword;
    
    if (useSearch) {
      const searchTag = 'A3';
      let searchCmd = `${searchTag} SEARCH`;
      if (unseenOnly) {
        searchCmd += ' UNSEEN';
      }
      if (keyword) {
        searchCmd += ` TEXT "${escapeString(keyword)}"`;
      }
      searchCmd += '\r\n';
      await helper.write(searchCmd);
      const searchResp = await helper.readImapResponse(searchTag);
      let seqs: number[] = [];
      for (const line of searchResp) {
        if (line.startsWith('* SEARCH')) {
          const parts = line.substring(9).trim().split(' ');
          for (const p of parts) {
            const num = parseInt(p);
            if (!isNaN(num)) seqs.push(num);
          }
        }
      }
      if (seqs.length === 0) {
        return { folder, total: 0, page, pageSize, messages: [] };
      }
      totalCount = seqs.length;
      // 逆序排列（最新在前）
      seqs.sort((a, b) => b - a);
      const startIdx = (page - 1) * pageSize;
      const paginatedSeqs = seqs.slice(startIdx, startIdx + pageSize);
      if (paginatedSeqs.length === 0) {
        return { folder, total: totalCount, page, pageSize, messages: [] };
      }
      sequenceRange = paginatedSeqs.join(',');
    } else {
      // 最新邮件在最后，所以逆向分页。exists 到 1。
      const start = Math.max(1, exists - (page * pageSize) + 1);
      const end = Math.max(1, exists - ((page - 1) * pageSize));
      if (start > end || end < 1) {
        return { folder, total: exists, page, pageSize, messages: [] };
      }
      // IMAP 的 sequence-set 中 start:end 表示范围（小到大）
      sequenceRange = `${start}:${end}`;
    }

    // 3. FETCH 头数据
    const fetchTag = 'A4';
    await helper.write(`${fetchTag} FETCH ${sequenceRange} (UID FLAGS INTERNALDATE ENVELOPE)\r\n`);
    
    const fetchResp = await helper.readImapResponse(fetchTag);
    const messages = parseImapFetchEnvelope(fetchResp);
    
    messages.sort((a, b) => b.uid - a.uid);

    return {
      folder,
      total: totalCount,
      page,
      pageSize,
      messages
    };
  });
}

// 邮件详情获取
async function fetchMessageDetail(conn: any, folder: string, uid: number) {
  return executeImap(conn, async (helper) => {
    // 1. SELECT 文件夹
    const selectTag = 'A2';
    await helper.write(`${selectTag} SELECT "${escapeString(folder)}"\r\n`);
    const selectResp = await helper.readImapResponse(selectTag);
    if (!selectResp[selectResp.length - 1].includes(' OK')) {
      throw new Error(`Select folder ${folder} failed`);
    }

    // 2. 获取头部和整封信的结构或直接全部拉取 MIME 自行解析
    // 直接 FETCH BODY.PEEK[] 拉取完整的 MIME 原文，这样可以用原生解析最稳妥
    const fetchTag = 'A3';
    await helper.write(`${fetchTag} UID FETCH ${uid} (BODY.PEEK[] FLAGS INTERNALDATE ENVELOPE)\r\n`);
    
    const fetchResp = await helper.readImapResponse(fetchTag);
    const rawMime = parseImapFetchBody(fetchResp);
    const envelopeList = parseImapFetchEnvelope(fetchResp);
    const envelope = envelopeList[0] || {};

    // 极简 MIME Parser 提取 Text & HTML & Header
    const parsed = parseMime(rawMime);

    return {
      uid,
      seq: envelope.seq || 0,
      subject: parsed.subject || envelope.subject || '(无主题)',
      from: parsed.from?.length ? parsed.from : envelope.from || [],
      to: parsed.to?.length ? parsed.to : envelope.to || [],
      cc: parsed.cc || [],
      bcc: parsed.bcc || [],
      replyTo: parsed.replyTo || [],
      date: parsed.date || envelope.date || new Date().toISOString(),
      seen: envelope.seen ?? true,
      flagged: envelope.flagged ?? false,
      hasAttachment: parsed.hasAttachment || false,
      snippet: parsed.text ? parsed.text.substring(0, 100) : '',
      size: rawMime.length,
      text: parsed.text || '',
      html: parsed.html || '',
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
      references: parsed.references || '',
      attachments: parsed.attachments || [],
    };
  });
}

// 通过 LIST 查找带指定 special-use 标志（如 \Trash、\Junk）的文件夹名。
// 未命中时返回 null。
async function findSpecialUseFolder(helper: any, use: string): Promise<string | null> {
  const tag = 'A2SU';
  await helper.write(`${tag} LIST "" "*"\r\n`);
  const resp = await helper.readImapResponse(tag);
  const flagPattern = new RegExp(`\\\\${use}\\b`, 'i');

  for (const line of resp) {
    const match = line.match(/\*\s+LIST\s+\((.*?)\)\s+(?:"[^"]*"|\S+)\s+(?:"(.*?)"|(\S+))/i);
    if (!match) continue;
    if (!flagPattern.test(match[1])) continue;
    const rawName = match[2] != null ? match[2] : match[3];
    return rawName.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return null;
}

// 操作邮件（已读、星标、删除）
async function applyMailAction(conn: any, folder: string, action: any) {
  return executeImap(conn, async (helper) => {
    const selectTag = 'A2';
    await helper.write(`${selectTag} SELECT "${escapeString(folder)}"\r\n`);
    const selectResp = await helper.readImapResponse(selectTag);
    if (!selectResp[selectResp.length - 1].includes(' OK')) {
      throw new Error(`Select folder ${folder} failed`);
    }

    const tag = 'A3';
    const uidsStr = action.uids.join(',');

    if (action.type === 'markSeen') {
      const op = action.seen ? '+FLAGS' : '-FLAGS';
      await helper.write(`${tag} UID STORE ${uidsStr} ${op} (\\Seen)\r\n`);
    } else if (action.type === 'flag') {
      const op = action.flagged ? '+FLAGS' : '-FLAGS';
      await helper.write(`${tag} UID STORE ${uidsStr} ${op} (\\Flagged)\r\n`);
    } else if (action.type === 'delete') {
      const isGmail = String(conn.imapHost).toLowerCase().includes('gmail') ||
                      String(conn.imapHost).toLowerCase().includes('imap.google');
      const isTrashFolder = folder.toLowerCase().includes('trash') ||
                            folder.toLowerCase().includes('已删除');

      if (isGmail && !isTrashFolder) {
        // Gmail: MOVE 到废纸篓。Gmail 的 EXPUNGE 只移除标签，不会真正删除。
        // 废纸篓名称随账户语言不同（[Gmail]/Trash 或 [Gmail]/已删除邮件），
        // 通过 LIST 动态查找带 \Trash special-use 标志的文件夹。
        const trashFolder = await findSpecialUseFolder(helper, 'Trash');
        const candidates = trashFolder
          ? [trashFolder, '[Gmail]/Trash']
          : ['[Gmail]/Trash'];

        let moved = false;
        const errors: string[] = [];
        for (let i = 0; i < candidates.length; i++) {
          const moveTag = `A3M${i}`;
          await helper.write(`${moveTag} UID MOVE ${uidsStr} "${escapeString(candidates[i])}"\r\n`);
          const moveResp = await helper.readImapResponse(moveTag);
          const moveLast = moveResp[moveResp.length - 1];
          if (moveLast.includes(' OK')) {
            moved = true;
            break;
          }
          errors.push(`${candidates[i]}: ${moveLast}`);
        }
        if (!moved) {
          throw new Error('Failed to move messages to Trash: ' + errors.join(' | '));
        }
      } else {
        // 非 Gmail 或已在废纸篓：标记 \Deleted + EXPUNGE 永久删除
        await helper.write(`${tag} UID STORE ${uidsStr} +FLAGS (\\Deleted)\r\n`);
        const storeResp = await helper.readImapResponse(tag);
        const storeLast = storeResp[storeResp.length - 1];
        if (!storeLast.includes(' OK')) {
          throw new Error('Failed to mark messages as deleted: ' + storeLast);
        }

        const expungeTag = 'A4';
        await helper.write(`${expungeTag} UID EXPUNGE ${uidsStr}\r\n`);
        const expungeResp = await helper.readImapResponse(expungeTag);
        const expungeLast = expungeResp[expungeResp.length - 1];
        if (!expungeLast.includes(' OK')) {
          const fallbackTag = 'A5';
          await helper.write(`${fallbackTag} EXPUNGE\r\n`);
          await helper.readImapResponse(fallbackTag);
        }
      }
      return { updated: action.uids.length };
    } else if (action.type === 'move') {
      await helper.write(`${tag} UID MOVE ${uidsStr} "${escapeString(action.folder)}"\r\n`);
    } else {
      throw new Error('Unsupported action type: ' + action.type);
    }

    const actionResp = await helper.readImapResponse(tag);
    const lastLine = actionResp[actionResp.length - 1];
    if (!lastLine.includes(' OK')) {
      throw new Error('Mail action failed: ' + lastLine);
    }

    return { updated: action.uids.length };
  });
}

// ==========================================
// SMTP 发信封装
// ==========================================

async function sendEmail(conn: any, mail: any) {
  // Gmail 等发信：SMTP_SSL (465) 或 SMTP+STARTTLS (587)
  const useTls = conn.smtpSecure; // 465 走直接 TLS。587 走 TCP 之后 STARTTLS 升级
  const helper = new SocketHelper(conn.smtpHost, conn.smtpPort, useTls);

  try {
    // 1. 等待 220 欢迎语
    let resp = await helper.readSmtpResponse();
    if (!resp.startsWith('220')) {
      throw new Error('SMTP initial handshake failed: ' + resp);
    }

    // 2. 送 EHLO
    await helper.write(`EHLO ${conn.smtpHost}\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('250')) {
      throw new Error('EHLO failed: ' + resp);
    }

    // 3. 处理 STARTTLS
    if (conn.smtpStartTLS) {
      await helper.write('STARTTLS\r\n');
      resp = await helper.readSmtpResponse();
      if (!resp.startsWith('220')) {
        throw new Error('STARTTLS failed: ' + resp);
      }
      // 核心：升级 Socket 为 TLS 模式
      await helper.startTls();

      // 再次发送 EHLO
      await helper.write(`EHLO ${conn.smtpHost}\r\n`);
      resp = await helper.readSmtpResponse();
      if (!resp.startsWith('250')) {
        throw new Error('EHLO after STARTTLS failed: ' + resp);
      }
    }

    // 4. 登录
    await helper.write('AUTH LOGIN\r\n');
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('334')) {
      throw new Error('AUTH LOGIN initiation failed: ' + resp);
    }

    // 账号 Base64
    const userB64 = btoa(conn.username || conn.email);
    await helper.write(`${userB64}\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('334')) {
      throw new Error('SMTP Username auth failed: ' + resp);
    }

    // 密码 Base64
    const passB64 = btoa(conn.password);
    await helper.write(`${passB64}\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('235')) {
      throw new Error('SMTP Authentication credentials failed: ' + resp);
    }

    // 5. MAIL FROM
    await helper.write(`MAIL FROM:<${conn.email}>\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('250')) {
      throw new Error('MAIL FROM failed: ' + resp);
    }

    // 6. RCPT TO
    const allRecipients = [
      ...(mail.to || []),
      ...(mail.cc || []),
      ...(mail.bcc || []),
    ];
    for (const to of allRecipients) {
      const emailOnly = extractEmailAddress(to);
      await helper.write(`RCPT TO:<${emailOnly}>\r\n`);
      resp = await helper.readSmtpResponse();
      if (!resp.startsWith('250')) {
        throw new Error(`RCPT TO <${emailOnly}> failed: ` + resp);
      }
    }

    // 7. DATA
    await helper.write('DATA\r\n');
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('354')) {
      throw new Error('DATA cmd initiation failed: ' + resp);
    }

    // 8. 组装 MIME 头并发送内容
    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@cloudflare-worker-mail>`;
    let mime = '';
    mime += `Message-ID: ${messageId}\r\n`;
    mime += `From: ${mail.fromName ? `${encodeMailHeader(mail.fromName)} ` : ''}<${conn.email}>\r\n`;
    mime += `To: ${mail.to.join(', ')}\r\n`;
    if (mail.cc?.length) mime += `Cc: ${mail.cc.join(', ')}\r\n`;
    mime += `Subject: ${encodeMailHeader(mail.subject)}\r\n`;
    mime += `Date: ${new Date().toUTCString()}\r\n`;
    mime += `MIME-Version: 1.0\r\n`;

    if (mail.inReplyTo) mime += `In-Reply-To: ${mail.inReplyTo}\r\n`;
    if (mail.references) mime += `References: ${mail.references}\r\n`;

    const hasAttachments = mail.attachments && mail.attachments.length > 0;
    const mixedBoundary = hasAttachments ? '----=_Mixed_Part_' + Math.random().toString(36).slice(2, 10) : '';

    if (hasAttachments) {
      mime += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n\r\n`;
      mime += `--${mixedBoundary}\r\n`;
    }

    // 正文：简单混合正文
    if (mail.text && mail.html) {
      const boundary = '----=_Part_' + Math.random().toString(36).slice(2, 10);
      mime += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
      
      mime += `--${boundary}\r\n`;
      mime += `Content-Type: text/plain; charset=UTF-8\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
      mime += utf8ToBase64(mail.text.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n') + '\r\n\r\n';

      mime += `--${boundary}\r\n`;
      mime += `Content-Type: text/html; charset=UTF-8\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
      mime += utf8ToBase64(mail.html.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n') + '\r\n\r\n';

      mime += `--${boundary}--`;
    } else if (mail.html) {
      mime += `Content-Type: text/html; charset=UTF-8\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
      mime += utf8ToBase64(mail.html.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n');
    } else {
      mime += `Content-Type: text/plain; charset=UTF-8\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
      mime += utf8ToBase64((mail.text || '').replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n');
    }

    if (hasAttachments) {
      mime += '\r\n';
      for (const att of mail.attachments) {
        const attMimeType = att.mimeType || 'application/octet-stream';
        mime += `--${mixedBoundary}\r\n`;
        mime += `Content-Type: ${attMimeType}; name="${encodeMailHeader(att.filename)}"\r\n`;
        mime += `Content-Disposition: attachment; filename="${encodeMailHeader(att.filename)}"\r\n`;
        mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
        let cleanBase64 = att.content;
        if (cleanBase64.includes(';base64,')) {
          cleanBase64 = cleanBase64.split(';base64,')[1];
        }
        mime += cleanBase64.replace(/\s/g, '').match(/.{1,76}/g)?.join('\r\n') + '\r\n';
      }
      mime += `--${mixedBoundary}--`;
    }

    // SMTP 数据以 \r\n.\r\n 结尾
    // 必须要处理正文里如果有独立的一点 "."，将其转成两个 "."
    const safeContent = mime.replace(/\r?\n\./g, '\r\n..');
    await helper.write(safeContent + '\r\n.\r\n');

    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('250')) {
      throw new Error('Mail transmission failed: ' + resp);
    }

    // 9. QUIT
    await helper.write('QUIT\r\n');
    await helper.readSmtpResponse();

    return { messageId };
  } finally {
    await helper.close();
  }
}

// 解决 JavaScript btoa 在处理中文等 unicode 时报错的问题
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + chunkSize)));
  }
  return btoa(binary);
}

function extractEmailAddress(addressStr: string): string {
  const match = addressStr.match(/<([^>]+)>/);
  return match ? match[1].trim() : addressStr.trim();
}

function encodeMailHeader(text: string): string {
  // 如果全是 ASCII，不需要进行 Q-encoding/B-encoding
  if (/^[ -~]*$/.test(text)) return text;
  // 使用 Base64 进行 UTF-8 编码
  const b64 = utf8ToBase64(text);
  return `=?UTF-8?B?${b64}?=`;
}

// ==========================================
// IMAP 响应及 Envelope 解析
// ==========================================


function extractEnvelope(rest: string): string | null {
  const envIdx = rest.indexOf('ENVELOPE');
  if (envIdx === -1) return null;
  
  let startIdx = envIdx + 8;
  while (startIdx < rest.length && rest[startIdx] !== '(') {
    startIdx++;
  }
  if (startIdx >= rest.length) return null;

  return rest.substring(startIdx + 1);
}

function parseImapFetchEnvelope(lines: string[]): any[] {
  const fullText = lines.join('\n');
  const list: any[] = [];
  
  const blocks = fullText.split(/\n(?=\*\s+\d+\s+FETCH\s+\(|\w+\s+OK)/);
  
  for (const block of blocks) {
    const match = block.match(/^\*\s+(\d+)\s+FETCH\s+\(([\s\S]*)/i);
    if (!match) continue;
    
    const seq = parseInt(match[1]);
    const rest = match[2];
    
    const currentObj: any = { seq, seen: false, flagged: false };
    
    const uidMatch = rest.match(/UID\s+(\d+)/i);
    if (uidMatch) currentObj.uid = parseInt(uidMatch[1]);
    
    const flagsMatch = rest.match(/FLAGS\s+\((.*?)\)/i);
    if (flagsMatch) {
      const flagsStr = flagsMatch[1].toLowerCase();
      currentObj.seen = flagsStr.includes('\\seen');
      currentObj.flagged = flagsStr.includes('\\flagged');
    }

    const dateMatch = rest.match(/INTERNALDATE\s+"([^"]+)"/i);
    if (dateMatch) currentObj.date = dateMatch[1];

    const envContent = extractEnvelope(rest);
    if (envContent) {
      parseEnvelopeString(envContent, currentObj);
    }
    
    list.push(currentObj);
  }

  console.log("IMAP FETCH parsed messages count:", list.length);
  if (list.length === 0 && fullText.length > 0) {
    console.log("Failed to parse any messages. Raw IMAP Text length:", fullText.length);
    console.log("Raw IMAP Text preview:", fullText.substring(0, 500));
  }

  return list;
}

function parseEnvelopeString(envStr: string, targetObj: any) {
  // Envelope 结构为括号嵌套：(Date Subject From Sender ReplyTo To Cc Bcc InReplyTo MessageID)
  // 我们做一个超级简化的括号分词器
  const parts = parseParentheses(envStr);
  if (parts.length >= 10) {
    targetObj.envelopeDate = cleanEnvValue(parts[0]);
    targetObj.subject = decodeImapHeader(cleanEnvValue(parts[1]));
    targetObj.from = parseAddressesGroup(parts[2]);
    targetObj.sender = parseAddressesGroup(parts[3]);
    targetObj.replyTo = parseAddressesGroup(parts[4]);
    targetObj.to = parseAddressesGroup(parts[5]);
    targetObj.cc = parseAddressesGroup(parts[6]);
    targetObj.bcc = parseAddressesGroup(parts[7]);
    targetObj.inReplyTo = cleanEnvValue(parts[8]);
    targetObj.messageId = cleanEnvValue(parts[9]);
  }
}

function cleanEnvValue(val: string): string {
  if (!val || val.toUpperCase() === 'NIL') return '';
  if (val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return val;
}

function parseAddressesGroup(val: string): any[] {
  if (!val || val.toUpperCase() === 'NIL') return [];
  // 结构：((Name Route User Host) (Name Route User Host) ...)
  // 去掉外层括号
  let inner = val.trim();
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1);
  }
  
  const items = parseParentheses(inner);
  const addresses: any[] = [];
  
  for (const item of items) {
    // 每一个 item 是 (Name Route User Host)
    const elements = parseParentheses(item.slice(1, -1));
    if (elements.length >= 4) {
      const name = cleanEnvValue(elements[0]);
      const user = cleanEnvValue(elements[2]);
      const host = cleanEnvValue(elements[3]);
      addresses.push({
        name: name ? decodeImapHeader(name) : undefined,
        address: `${user}@${host}`,
      });
    }
  }
  return addresses;
}

function parseParentheses(str: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"' && str[i - 1] !== '\\') {
      inQuote = !inQuote;
      current += char;
    } else if (inQuote) {
      current += char;
    } else if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
      if (depth === 0) {
        result.push(current.trim());
        current = '';
      }
    } else if (depth > 0) {
      current += char;
    } else {
      // 在层级 0 时，空格作为分词符号
      if (char === ' ') {
        if (current.trim()) {
          result.push(current.trim());
          current = '';
        }
      } else {
        current += char;
      }
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

// 解析 FETCH BODY
function parseImapFetchBody(lines: string[]): string {
  // 首行类似：* 1 FETCH (UID 45 BODY[] {2456}
  // 紧接着是内容，最后一行以括号结尾（或者是新的一行带有 tag OK）
  // 简单的做法是把首尾行过滤，其余拼合。
  let raw = '';
  let collecting = false;
  let byteCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!collecting) {
      const match = line.match(/BODY\[.*\]\s+\{(\d+)\}/i);
      if (match) {
        byteCount = parseInt(match[1]);
        collecting = true;
        // 把当前行在大括号后面的部分作为内容一部分（如果有的话，IMAP 换行之后通常是直接数据数据）
      }
    } else {
      raw += line;
      if (raw.length >= byteCount) {
        // 剪裁到指定的字节数
        raw = raw.substring(0, byteCount);
        break;
      }
    }
  }
  return raw;
}

// ==========================================
// 极简 MIME Parser (解析 HTML, Text, 编码等)
// ==========================================

function decodeImapHeader(val: string): string {
  if (!val) return '';
  // 格式：=?utf-8?B?5aSn5a625aW9?= 或 =?utf-8?Q?=E5=A4=A7=E5=AE=B6=E5=A5=BD?=
  const regex = /=\?([^?]+)\?([QB])\?([^?]*)\?=/gi;
  return val.replace(regex, (match, charset, encoding, text) => {
    if (encoding.toUpperCase() === 'B') {
      try {
        const bin = atob(text);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return text;
      }
    } else if (encoding.toUpperCase() === 'Q') {
      // QP 解码
      let qp = text.replace(/_/g, ' ');
      qp = qp.replace(/=([0-9A-F]{2})/gi, (m: string, hex: string) => {
        return String.fromCharCode(parseInt(hex, 16));
      });
      try {
        const bytes = new Uint8Array(qp.length);
        for (let i = 0; i < qp.length; i++) {
          bytes[i] = qp.charCodeAt(i);
        }
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return qp;
      }
    }
    return match;
  });
}

function parseMime(raw: string): any {
  const result: any = {
    subject: '',
    from: [],
    to: [],
    cc: [],
    bcc: [],
    date: '',
    text: '',
    html: '',
    messageId: '',
    inReplyTo: '',
    references: '',
    hasAttachment: false,
    attachments: [],
  };

  // 分离 Header 和 Body
  const splitIdx = raw.search(/\r?\n\r?\n/);
  if (splitIdx < 0) return result;

  const headerPart = raw.substring(0, splitIdx);
  const bodyPart = raw.substring(splitIdx).trim();

  // 解析 Headers
  const headers = parseHeaders(headerPart);
  result.subject = decodeImapHeader(headers['subject'] || '');
  result.messageId = headers['message-id'] || '';
  result.inReplyTo = headers['in-reply-to'] || '';
  result.references = headers['references'] || '';
  result.date = headers['date'] || '';

  if (headers['from']) result.from = parseRawAddressHeader(headers['from']);
  if (headers['to']) result.to = parseRawAddressHeader(headers['to']);
  if (headers['cc']) result.cc = parseRawAddressHeader(headers['cc']);
  if (headers['bcc']) result.bcc = parseRawAddressHeader(headers['bcc']);

  // 解析 Body (处理 Multipart / Content-Transfer-Encoding)
  const contentType = headers['content-type'] || '';
  const transferEncoding = headers['content-transfer-encoding'] || '';

  parseBodyPart(bodyPart, contentType, transferEncoding, result);

  return result;
}

function parseHeaders(rawHeaders: string): Record<string, string> {
  const map: Record<string, string> = {};
  // 必须处理跨行展开的 Header 行
  const lines = rawHeaders.split(/\r?\n/);
  let currentKey = '';
  
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (currentKey) {
        map[currentKey] += ' ' + line.trim();
      }
    } else {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        currentKey = line.substring(0, colonIdx).toLowerCase().trim();
        map[currentKey] = line.substring(colonIdx + 1).trim();
      }
    }
  }
  return map;
}

function parseRawAddressHeader(val: string): any[] {
  // 格式： Thom <thom@example.com>, "Jobs" <jobs@apple.com>
  const addresses: any[] = [];
  const parts = val.split(',');
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    const match = part.match(/(.*?)<([^>]+)>/);
    if (match) {
      let name = match[1].trim();
      if (name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1);
      }
      addresses.push({
        name: decodeImapHeader(name) || undefined,
        address: match[2].trim(),
      });
    } else {
      addresses.push({
        address: part,
      });
    }
  }
  return addresses;
}

function parseBodyPart(body: string, contentType: string, transferEncoding: string, result: any) {
  const cType = contentType.toLowerCase();
  
  // Multipart 处理
  if (cType.includes('multipart/')) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
    if (!boundaryMatch) {
      // 降级：如果找不到 boundary，直接当做普通文本存
      result.text = body;
      return;
    }
    const boundary = boundaryMatch[1];
    const parts = body.split('--' + boundary);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === '--') continue;

      const subSplit = trimmed.search(/\r?\n\r?\n/);
      if (subSplit < 0) continue;

      const subHeaderRaw = trimmed.substring(0, subSplit);
      const subBodyRaw = trimmed.substring(subSplit).trim();

      const subHeaders = parseHeaders(subHeaderRaw);
      const subCType = subHeaders['content-type'] || '';
      const subCEncoding = subHeaders['content-transfer-encoding'] || '';
      
      const disposition = subHeaders['content-disposition'] || '';
      const isAttachment = disposition.toLowerCase().includes('attachment') || disposition.toLowerCase().includes('inline; filename=');
      let filename = '';
      const dispMatch = disposition.match(/filename="?([^";\r\n]+)"?/i);
      if (dispMatch) {
        filename = dispMatch[1];
      } else {
        const typeMatch = subCType.match(/name="?([^";\r\n]+)"?/i);
        if (typeMatch) {
          filename = typeMatch[1];
        }
      }

      if (isAttachment || filename) {
        result.hasAttachment = true;
        if (!result.attachments) result.attachments = [];

        if (!filename) {
          filename = 'attachment_' + (result.attachments.length + 1);
        }
        filename = decodeImapHeader(filename);

        let base64Content = '';
        const encoding = subCEncoding.toLowerCase().trim();
        if (encoding === 'base64') {
          base64Content = subBodyRaw.replace(/[\r\n\s]/g, '');
        } else {
          let rawBin = subBodyRaw;
          if (encoding === 'quoted-printable') {
            let qp = subBodyRaw.replace(/=\r?\n/g, '');
            qp = qp.replace(/=([0-9A-F]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
            rawBin = qp;
          }
          base64Content = btoa(rawBin);
        }

        const mimeType = subCType.split(';')[0].trim().toLowerCase();

        result.attachments.push({
          filename,
          mimeType,
          content: base64Content,
          size: Math.round((base64Content.length * 3) / 4)
        });
        continue;
      }

      parseBodyPart(subBodyRaw, subCType, subCEncoding, result);
    }
  } else {
    // 单一正文
    let decoded = body;
    const encoding = transferEncoding.toLowerCase().trim();
    if (encoding === 'base64') {
      try {
        const cleaned = body.replace(/[\r\n\s]/g, '');
        const bin = atob(cleaned);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
        // 读取 Content-Type 里的 charset
        const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i);
        const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
        decoded = new TextDecoder(charset).decode(bytes);
      } catch (err) {
        decoded = body; // 降级
      }
    } else if (encoding === 'quoted-printable') {
      let qp = body.replace(/=\r?\n/g, ''); // 软换行
      qp = qp.replace(/=([0-9A-F]{2})/gi, (m: string, hex: string) => {
        return String.fromCharCode(parseInt(hex, 16));
      });
      try {
        const bytes = new Uint8Array(qp.length);
        for (let i = 0; i < qp.length; i++) {
          bytes[i] = qp.charCodeAt(i);
        }
        const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i);
        const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
        decoded = new TextDecoder(charset).decode(bytes);
      } catch {
        decoded = qp;
      }
    }

    if (cType.includes('text/html')) {
      result.html = decoded;
    } else if (cType.includes('text/plain') || !result.text) {
      result.text = decoded;
    }
  }
}
