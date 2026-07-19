const http = require('http');
const net = require('net');
const tls = require('tls');
const { TextDecoder, TextEncoder } = require('util');

const atob = globalThis.atob || ((str) => Buffer.from(str, 'base64').toString('binary'));
const btoa = globalThis.btoa || ((str) => Buffer.from(str, 'binary').toString('base64'));

// ==========================================
// Socket 通信助手：处理原生 IMAP 和 SMTP 行
// ==========================================

class SocketHelper {
  constructor(host, port, useTls) {
    const numPort = Number(port);
    const isTls = String(useTls) === 'true' || numPort === 993 || numPort === 465;
    this.host = String(host).trim();
    this.port = numPort;
    this.isTls = isTls;
    this.buffer = '';
    this.readQueue = [];
    this.closed = false;

    console.log(`[Socket] Connecting to ${this.host}:${this.port} (TLS: ${this.isTls})`);

    const connectionOptions = { host: this.host, port: this.port };
    if (this.isTls) {
      connectionOptions.rejectUnauthorized = false; // 忽略自签名证书等问题
      this.socket = tls.connect(connectionOptions, () => {
        console.log(`[Socket] Connected via TLS to ${this.host}:${this.port}`);
      });
    } else {
      this.socket = net.connect(connectionOptions, () => {
        console.log(`[Socket] Connected via TCP to ${this.host}:${this.port}`);
      });
    }

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => {
      console.log(`[Socket] Closed connection to ${this.host}:${this.port}`);
      this.closed = true;
      this._resolveQueue(new Error('Socket closed'));
    });
    this.socket.on('error', (err) => {
      console.error(`[Socket] Error on connection to ${this.host}:${this.port}:`, err.message);
      this.closed = true;
      this._resolveQueue(err);
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    this._processQueue();
  }

  _resolveQueue(err) {
    while (this.readQueue.length > 0) {
      const { reject } = this.readQueue.shift();
      reject(err);
    }
  }

  _processQueue() {
    while (this.readQueue.length > 0) {
      const idx = this.buffer.indexOf('\n');
      if (idx !== -1) {
        const { resolve } = this.readQueue.shift();
        const line = this.buffer.substring(0, idx + 1);
        this.buffer = this.buffer.substring(idx + 1);
        resolve(line);
      } else {
        break; // 等待更多数据
      }
    }
  }

  async write(data) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Socket is closed'));
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      this.socket.write(bytes, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async readLine() {
    return new Promise((resolve, reject) => {
      const idx = this.buffer.indexOf('\n');
      if (idx !== -1) {
        const line = this.buffer.substring(0, idx + 1);
        this.buffer = this.buffer.substring(idx + 1);
        return resolve(line);
      }
      if (this.closed) {
        return reject(new Error('Socket is closed'));
      }
      this.readQueue.push({ resolve, reject });
    });
  }

  startTls() {
    console.log(`[Socket] Upgrading cleartext connection to TLS (STARTTLS) for ${this.host}:${this.port}`);
    this.socket.removeAllListeners('data');
    const upgraded = tls.connect({
      socket: this.socket,
      host: this.host,
      port: this.port,
      rejectUnauthorized: false
    });
    this.socket = upgraded;
    this.buffer = '';
    this.socket.on('data', (chunk) => this._onData(chunk));
  }

  async close() {
    try {
      this.socket.destroy();
    } catch { }
  }

  async readImapResponse(tag) {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (line.startsWith(tag + ' ')) {
        break;
      }
    }
    return lines;
  }

  async readSmtpResponse() {
    let result = '';
    while (true) {
      const line = await this.readLine();
      result += line;
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

async function executeImap(conn, fn) {
  const helper = new SocketHelper(conn.imapHost, conn.imapPort, conn.imapSecure);
  try {
    const banner = await helper.readLine();
    if (!banner.includes('OK')) {
      throw new Error('IMAP connection banner failed: ' + banner);
    }

    const loginTag = 'A1';
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
    } catch (e) {
      console.log('IMAP ID command failed or not supported:', e.message);
    }

    return await fn(helper);
  } finally {
    try {
      await helper.write('A999 LOGOUT\r\n');
    } catch { }
    await helper.close();
  }
}

function escapeString(val) {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function testConnection(conn) {
  return executeImap(conn, async (helper) => {
    const tag = 'A2';
    await helper.write(`${tag} SELECT "INBOX"\r\n`);
    const resp = await helper.readImapResponse(tag);
    const lastLine = resp[resp.length - 1];
    if (!lastLine.includes(' OK')) {
      throw new Error('Select INBOX failed: ' + lastLine);
    }

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

async function getFolders(conn) {
  return executeImap(conn, async (helper) => {
    const tag = 'A2';
    await helper.write(`${tag} LIST "" "*"\r\n`);
    const resp = await helper.readImapResponse(tag);

    const folders = [];
    for (const line of resp) {
      const match = line.match(/\*\s+LIST\s+\((.*?)\)\s+"(.*?)"\s+"(.*?)"/i);
      if (match) {
        folders.push({
          flags: match[1].split(' ').map(f => f.trim()),
          delimiter: match[2],
          name: unescapeImapFolderName(match[3]),
        });
      } else {
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

function unescapeImapFolderName(name) {
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  return name.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// 通过 LIST 查找带指定 special-use 标志（如 \Trash）的文件夹名，未命中返回 null
async function findSpecialUseFolder(helper, use) {
  const tag = 'A2SU';
  await helper.write(`${tag} LIST "" "*"\r\n`);
  const resp = await helper.readImapResponse(tag);
  const flagPattern = new RegExp(`\\\\${use}\\b`, 'i');

  for (const line of resp) {
    const match = line.match(/\*\s+LIST\s+\((.*?)\)\s+(?:"[^"]*"|\S+)\s+(?:"(.*?)"|(\S+))/i);
    if (!match) continue;
    if (!flagPattern.test(match[1])) continue;
    const rawName = match[2] != null ? match[2] : match[3];
    return unescapeImapFolderName(rawName);
  }
  return null;
}

async function fetchMessages(conn, folder, page, pageSize, unseenOnly, keyword) {
  return executeImap(conn, async (helper) => {
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
      let seqs = [];
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
      seqs.sort((a, b) => b - a);
      const startIdx = (page - 1) * pageSize;
      const paginatedSeqs = seqs.slice(startIdx, startIdx + pageSize);
      if (paginatedSeqs.length === 0) {
        return { folder, total: totalCount, page, pageSize, messages: [] };
      }
      sequenceRange = paginatedSeqs.join(',');
    } else {
      const start = Math.max(1, exists - (page * pageSize) + 1);
      const end = Math.max(1, exists - ((page - 1) * pageSize));
      if (start > end || end < 1) {
        return { folder, total: exists, page, pageSize, messages: [] };
      }
      sequenceRange = `${start}:${end}`;
    }

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

async function fetchMessageDetail(conn, folder, uid) {
  return executeImap(conn, async (helper) => {
    const selectTag = 'A2';
    await helper.write(`${selectTag} SELECT "${escapeString(folder)}"\r\n`);
    const selectResp = await helper.readImapResponse(selectTag);
    if (!selectResp[selectResp.length - 1].includes(' OK')) {
      throw new Error(`Select folder ${folder} failed`);
    }

    const fetchTag = 'A3';
    await helper.write(`${fetchTag} UID FETCH ${uid} (BODY.PEEK[] FLAGS INTERNALDATE ENVELOPE)\r\n`);

    const fetchResp = await helper.readImapResponse(fetchTag);
    const rawMime = parseImapFetchBody(fetchResp);
    const envelopeList = parseImapFetchEnvelope(fetchResp);
    const envelope = envelopeList[0] || {};

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

async function applyMailAction(conn, folder, action) {
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
        // 通过 LIST 动态查找带 \Trash special-use 标志的废纸篓（中英文账户名称不同）
        const trashFolder = await findSpecialUseFolder(helper, 'Trash');
        const candidates = trashFolder
          ? [trashFolder, '[Gmail]/Trash']
          : ['[Gmail]/Trash'];

        let moved = false;
        const errors = [];
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

async function sendEmail(conn, mail) {
  const useTls = conn.smtpSecure;
  const helper = new SocketHelper(conn.smtpHost, conn.smtpPort, useTls);

  try {
    let resp = await helper.readSmtpResponse();
    if (!resp.startsWith('220')) {
      throw new Error('SMTP initial handshake failed: ' + resp);
    }

    await helper.write(`EHLO ${conn.smtpHost}\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('250')) {
      throw new Error('EHLO failed: ' + resp);
    }

    if (conn.smtpStartTLS) {
      await helper.write('STARTTLS\r\n');
      resp = await helper.readSmtpResponse();
      if (!resp.startsWith('220')) {
        throw new Error('STARTTLS failed: ' + resp);
      }
      helper.startTls();

      await helper.write(`EHLO ${conn.smtpHost}\r\n`);
      resp = await helper.readSmtpResponse();
      if (!resp.startsWith('250')) {
        throw new Error('EHLO after STARTTLS failed: ' + resp);
      }
    }

    await helper.write('AUTH LOGIN\r\n');
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('334')) {
      throw new Error('AUTH LOGIN initiation failed: ' + resp);
    }

    const userB64 = btoa(conn.username || conn.email);
    await helper.write(`${userB64}\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('334')) {
      throw new Error('SMTP Username auth failed: ' + resp);
    }

    const passB64 = btoa(conn.password);
    await helper.write(`${passB64}\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('235')) {
      throw new Error('SMTP Authentication credentials failed: ' + resp);
    }

    await helper.write(`MAIL FROM:<${conn.email}>\r\n`);
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('250')) {
      throw new Error('MAIL FROM failed: ' + resp);
    }

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

    await helper.write('DATA\r\n');
    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('354')) {
      throw new Error('DATA cmd initiation failed: ' + resp);
    }

    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@local-mail-relay>`;
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

    const safeContent = mime.replace(/\r?\n\./g, '\r\n..');
    await helper.write(safeContent + '\r\n.\r\n');

    resp = await helper.readSmtpResponse();
    if (!resp.startsWith('250')) {
      throw new Error('Mail transmission failed: ' + resp);
    }

    await helper.write('QUIT\r\n');
    await helper.readSmtpResponse();

    return { messageId };
  } finally {
    await helper.close();
  }
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + chunkSize)));
  }
  return btoa(binary);
}

function extractEmailAddress(addressStr) {
  const match = addressStr.match(/<([^>]+)>/);
  return match ? match[1].trim() : addressStr.trim();
}

function encodeMailHeader(text) {
  if (/^[ -~]*$/.test(text)) return text;
  const b64 = utf8ToBase64(text);
  return `=?UTF-8?B?${b64}?=`;
}

// ==========================================
// IMAP 响应及 Envelope 解析
// ==========================================

function extractEnvelope(rest) {
  const envIdx = rest.indexOf('ENVELOPE');
  if (envIdx === -1) return null;

  let startIdx = envIdx + 8;
  while (startIdx < rest.length && rest[startIdx] !== '(') {
    startIdx++;
  }
  if (startIdx >= rest.length) return null;

  return rest.substring(startIdx + 1);
}

function parseImapFetchEnvelope(lines) {
  const fullText = lines.join('\n');
  const list = [];
  const blocks = fullText.split(/\n(?=\*\s+\d+\s+FETCH\s+\(|\w+\s+OK)/);

  for (const block of blocks) {
    const match = block.match(/^\*\s+(\d+)\s+FETCH\s+\(([\s\S]*)/i);
    if (!match) continue;

    const seq = parseInt(match[1]);
    const rest = match[2];

    const currentObj = { seq, seen: false, flagged: false };

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
  return list;
}

function parseEnvelopeString(envStr, targetObj) {
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

function cleanEnvValue(val) {
  if (!val || val.toUpperCase() === 'NIL') return '';
  if (val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return val;
}

function parseAddressesGroup(val) {
  if (!val || val.toUpperCase() === 'NIL') return [];
  let inner = val.trim();
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1);
  }

  const items = parseParentheses(inner);
  const addresses = [];

  for (const item of items) {
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

function parseParentheses(str) {
  const result = [];
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

function parseImapFetchBody(lines) {
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
      }
    } else {
      raw += line;
      if (raw.length >= byteCount) {
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

function decodeImapHeader(val) {
  if (!val) return '';
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
      let qp = text.replace(/_/g, ' ');
      qp = qp.replace(/=([0-9A-F]{2})/gi, (m, hex) => {
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

function parseMime(raw) {
  const result = {
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

  const splitIdx = raw.search(/\r?\n\r?\n/);
  if (splitIdx < 0) return result;

  const headerPart = raw.substring(0, splitIdx);
  const bodyPart = raw.substring(splitIdx).trim();

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

  const contentType = headers['content-type'] || '';
  const transferEncoding = headers['content-transfer-encoding'] || '';

  parseBodyPart(bodyPart, contentType, transferEncoding, result);

  return result;
}

function parseHeaders(rawHeaders) {
  const map = {};
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

function parseRawAddressHeader(val) {
  const addresses = [];
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

function parseBodyPart(body, contentType, transferEncoding, result) {
  const cType = contentType.toLowerCase();

  if (cType.includes('multipart/')) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
    if (!boundaryMatch) {
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
          try {
            base64Content = Buffer.from(rawBin, 'binary').toString('base64');
          } catch {
            base64Content = btoa(rawBin);
          }
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
        const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i);
        const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
        decoded = new TextDecoder(charset).decode(bytes);
      } catch (err) {
        decoded = body;
      }
    } else if (encoding === 'quoted-printable') {
      let qp = body.replace(/=\r?\n/g, '');
      qp = qp.replace(/=([0-9A-F]{2})/gi, (m, hex) => {
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

// ==========================================
// HTTP Server 接口
// ==========================================

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  const AUTH_TOKEN = process.env.AUTH_TOKEN || "dookcss"; // 设置你国内服务器的验证口令

  if (token !== AUTH_TOKEN) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid Auth Token' }));
    return;
  }

  let bodyStr = '';
  req.on('data', chunk => { bodyStr += chunk; });
  req.on('end', async () => {
    try {
      const body = JSON.parse(bodyStr || '{}');
      const connInfo = body.connection;
      const path = req.url;

      if (!connInfo || !connInfo.email || !connInfo.password) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'Missing connection details or password' }));
        return;
      }

      console.log(`[HTTP] Received request ${path} for ${connInfo.email}`);

      let result;
      if (path === '/v1/test') {
        result = await testConnection(connInfo);
      } else if (path === '/v1/folders') {
        result = await getFolders(connInfo);
      } else if (path === '/v1/messages') {
        const folder = body.folder || 'INBOX';
        const page = body.page || 1;
        const pageSize = body.pageSize || 20;
        const unseenOnly = !!body.unseenOnly;
        const keyword = body.keyword || '';
        result = await fetchMessages(connInfo, folder, page, pageSize, unseenOnly, keyword);
      } else if (path === '/v1/message') {
        const folder = body.folder || 'INBOX';
        const uid = parseInt(body.uid);
        if (isNaN(uid)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'Invalid UID' }));
          return;
        }
        result = await fetchMessageDetail(connInfo, folder, uid);
      } else if (path === '/v1/send') {
        const mail = body.mail;
        if (!mail || !mail.to || !mail.subject) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'Missing mail headers (to, subject)' }));
          return;
        }
        result = await sendEmail(connInfo, mail);
      } else if (path === '/v1/action') {
        const folder = body.folder || 'INBOX';
        const action = body.action;
        if (!action || !action.type || !action.uids) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'Invalid action parameters' }));
          return;
        }
        result = await applyMailAction(connInfo, folder, action);
      } else {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: result }));
    } catch (e) {
      console.error(`[HTTP] Error processing ${req.url}:`, e);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  });
});

const PORT = process.env.PORT || 18000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`  本地邮件直连中转服务启动成功！`);
  console.log(`  监听地址: http://0.0.0.0:${PORT}`);
  console.log(`  授权令牌(AUTH_TOKEN): ${process.env.AUTH_TOKEN || "local_dev_token"}`);
  console.log(`================================================================`);
});
