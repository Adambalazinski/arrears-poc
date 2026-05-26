import { Injectable, Logger } from '@nestjs/common';
import { htmlToPlainText, renderMarkdownToHtml } from './markdown-to-html';
import { ImapSmtpService } from './imap-smtp.service';
import {
  OutboundSendError,
  type InboundMessageFull,
  type InboundMessageSummary,
  type OutboundSendInput,
  type OutboundSendResult,
  type OutlookClient,
} from './outlook.types';

/**
 * OutlookClient implementation for generic IMAP+SMTP providers
 * (Gmail / Fastmail / etc.). Parallel to OutlookGraphClient; picked
 * at runtime via OUTBOUND_MODE=gmail / INBOUND_MODE=gmail.
 *
 * `outlookMessageId` semantics: for IMAP we use the per-mailbox UID
 * (numeric, stable for the life of the UIDVALIDITY counter — which
 * essentially never rotates on Gmail/Fastmail). Stored as a string so
 * the type lines up with the Graph variant. `moveTo`'s `folder`
 * argument is the IMAP folder name (e.g. "Processed", or for Gmail
 * the special "[Gmail]/All Mail").
 */
@Injectable()
export class ImapSmtpClient implements OutlookClient {
  private readonly logger = new Logger(ImapSmtpClient.name);

  constructor(private readonly svc: ImapSmtpService) {}

  async sendMail(input: OutboundSendInput): Promise<OutboundSendResult> {
    const creds = await this.svc.loadCredentials();
    const transport = this.svc.buildSmtpTransport(creds);
    const html = renderMarkdownToHtml(input.bodyMarkdown);
    const text = htmlToPlainText(html);
    try {
      const info = await transport.sendMail({
        from: creds.mailboxAddress,
        to: input.toAddress,
        subject: input.subject,
        html,
        text,
      });
      const messageId = info.messageId ?? `imap-smtp:${creds.mailboxAddress}:${Date.now()}`;
      this.logger.log(`imap-smtp: sent ${messageId} -> ${input.toAddress}`);
      void this.svc.touchLastUsed();
      return { messageId, acceptedAt: new Date() };
    } catch (err) {
      throw new OutboundSendError(
        `SMTP send failed: ${err instanceof Error ? err.message : err}`,
        err,
      );
    } finally {
      transport.close();
    }
  }

  async listInbound(sinceUtc: Date, limit = 50): Promise<InboundMessageSummary[]> {
    const client = await this.svc.openImap();
    try {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const searchResult = await client.search({ since: sinceUtc }, { uid: true });
      // imapflow returns `false` if no UIDs match, an array otherwise.
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
      // Oldest first so the inbound poll processes in arrival order.
      const ordered = [...uids].sort((a, b) => a - b).slice(0, limit);
      if (ordered.length === 0) return [];
      const summaries: InboundMessageSummary[] = [];
      for await (const msg of client.fetch(
        { uid: ordered.join(',') },
        { envelope: true, uid: true, internalDate: true, bodyStructure: true },
      )) {
        const from = msg.envelope?.from?.[0];
        summaries.push({
          outlookMessageId: String(msg.uid),
          fromAddress: from?.address ?? '',
          subject: msg.envelope?.subject ?? null,
          receivedAt: toDate(msg.envelope?.date ?? msg.internalDate),
        });
      }
      void this.svc.touchLastUsed();
      return summaries;
    } finally {
      await safeLogout(client);
    }
  }

  async getMessage(outlookMessageId: string): Promise<InboundMessageFull> {
    const uid = parseUid(outlookMessageId);
    const client = await this.svc.openImap();
    try {
      await client.mailboxOpen('INBOX', { readOnly: true });
      const msg = await client.fetchOne(
        String(uid),
        { envelope: true, source: true, bodyStructure: true, internalDate: true },
        { uid: true },
      );
      if (!msg) throw new Error(`IMAP UID ${uid} not found in INBOX`);
      const raw = msg.source?.toString('utf-8') ?? '';
      const { text, html } = extractBodies(raw);
      const from = msg.envelope?.from?.[0];
      return {
        outlookMessageId: String(uid),
        fromAddress: from?.address ?? '',
        subject: msg.envelope?.subject ?? null,
        receivedAt: toDate(msg.envelope?.date ?? msg.internalDate),
        bodyText: text,
        bodyHtml: html,
        bodyPreview: text.slice(0, 200),
      };
    } finally {
      await safeLogout(client);
    }
  }

  async markRead(outlookMessageId: string): Promise<void> {
    const uid = parseUid(outlookMessageId);
    const client = await this.svc.openImap();
    try {
      await client.mailboxOpen('INBOX', { readOnly: false });
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } finally {
      await safeLogout(client);
    }
  }

  async moveTo(outlookMessageId: string, folder: string): Promise<void> {
    const uid = parseUid(outlookMessageId);
    const client = await this.svc.openImap();
    try {
      await client.mailboxOpen('INBOX', { readOnly: false });
      await client.messageMove(String(uid), folder, { uid: true });
    } finally {
      await safeLogout(client);
    }
  }
}

function toDate(v: Date | string | undefined | null): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return new Date();
}

function parseUid(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid IMAP UID: ${s}`);
  }
  return n;
}

async function safeLogout(client: { logout: () => Promise<void> }): Promise<void> {
  try {
    await client.logout();
  } catch {
    // best-effort
  }
}

/**
 * Pulls plaintext + html bodies out of a raw MIME message. Keeps the
 * dependency surface minimal — no extra MIME parser library. Works for
 * the simple `text/plain`, `text/html`, and `multipart/alternative`
 * shapes that real-world tenant replies will be.
 */
function extractBodies(raw: string): { text: string; html: string | null } {
  if (!raw) return { text: '', html: null };
  const headerEnd = findHeaderEnd(raw);
  const headers = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd).replace(/^\r?\n/, '');
  const ct = headerValue(headers, 'content-type') ?? 'text/plain';
  const cte = headerValue(headers, 'content-transfer-encoding') ?? '7bit';

  if (/^multipart\/alternative/i.test(ct)) {
    const boundary = ctParam(ct, 'boundary');
    if (boundary) {
      const parts = splitMultipart(body, boundary);
      let text = '';
      let html: string | null = null;
      for (const part of parts) {
        const pHeaderEnd = findHeaderEnd(part);
        const pHeaders = part.slice(0, pHeaderEnd);
        const pBody = part.slice(pHeaderEnd).replace(/^\r?\n/, '');
        const pCt = headerValue(pHeaders, 'content-type') ?? '';
        const pCte = headerValue(pHeaders, 'content-transfer-encoding') ?? '7bit';
        if (/^text\/html/i.test(pCt)) html = decodeBody(pBody, pCte);
        if (/^text\/plain/i.test(pCt)) text = decodeBody(pBody, pCte);
      }
      if (!text && html) text = htmlToPlainText(html);
      return { text, html };
    }
  }
  if (/^text\/html/i.test(ct)) {
    const html = decodeBody(body, cte);
    return { text: htmlToPlainText(html), html };
  }
  return { text: decodeBody(body, cte), html: null };
}

function findHeaderEnd(raw: string): number {
  // RFC 5322: header/body separator is CRLF CRLF. Tolerate LF LF too.
  const idxCrlf = raw.indexOf('\r\n\r\n');
  if (idxCrlf >= 0) return idxCrlf + 4;
  const idxLf = raw.indexOf('\n\n');
  if (idxLf >= 0) return idxLf + 2;
  return raw.length;
}

function headerValue(headers: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+?)(?:\\r?\\n[^\\s])`, 'ims');
  // Single-line header: ^name: value$
  const single = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const continued = headers.match(re);
  if (continued) return continued[1]!.replace(/\r?\n\s+/g, ' ').trim();
  const m = headers.match(single);
  return m ? m[1]!.trim() : null;
}

function ctParam(ct: string, name: string): string | null {
  const m = ct.match(new RegExp(`${name}=\"?([^;\"]+)\"?`, 'i'));
  return m ? m[1]! : null;
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const delim = `--${boundary}`;
  const segments = body.split(delim);
  for (const seg of segments) {
    const trimmed = seg.replace(/^\r?\n/, '');
    if (!trimmed || trimmed.startsWith('--')) continue; // closing boundary
    parts.push(trimmed);
  }
  return parts;
}

function decodeBody(body: string, cte: string): string {
  switch (cte.toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    case '7bit':
    case '8bit':
    case 'binary':
    default:
      return body;
  }
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
