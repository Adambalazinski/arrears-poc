import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { Injectable, Logger } from '@nestjs/common';
import { htmlToPlainText, renderMarkdownToHtml } from './markdown-to-html';
import {
  OutboundSendError,
  type InboundMessageFull,
  type InboundMessageSummary,
  type OutboundSendInput,
  type OutboundSendResult,
  type OutlookClient,
} from './outlook.types';

const GRAPH_SCOPES = ['https://graph.microsoft.com/.default'];

@Injectable()
export class OutlookGraphClient implements OutlookClient {
  private readonly logger = new Logger(OutlookGraphClient.name);
  private cached?: { client: Client; mailbox: string };

  /**
   * Lazy init — the client is only constructed on first call. Lets fixture
   * mode and Mailhog mode run without OUTLOOK_* env vars being set.
   */
  private getClient(): { client: Client; mailbox: string } {
    if (this.cached) return this.cached;
    const tenantId = requireEnv('OUTLOOK_TENANT_ID');
    const clientId = requireEnv('OUTLOOK_CLIENT_ID');
    const clientSecret = requireEnv('OUTLOOK_CLIENT_SECRET');
    const mailbox = requireEnv('OUTLOOK_SHARED_MAILBOX');
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: GRAPH_SCOPES,
    });
    const client = Client.initWithMiddleware({ authProvider });
    this.cached = { client, mailbox };
    return this.cached;
  }

  async sendMail(input: OutboundSendInput): Promise<OutboundSendResult> {
    const { client, mailbox } = this.getClient();
    const html = renderMarkdownToHtml(input.bodyMarkdown);
    const text = htmlToPlainText(html);
    const payload = {
      message: {
        subject: input.subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: input.toAddress } }],
        // Plain-text fallback is documented per integrations.md — Graph's
        // sendMail doesn't have a dedicated field; we keep the text version
        // ready for any future alternative-format work.
      },
      saveToSentItems: true,
    };
    void text; // kept for future plain-text alternative; explicitly unused.
    try {
      // sendMail returns 202 Accepted with no body. We don't get a server
      // message-id back; using saveToSentItems lets ops correlate via the
      // mailbox itself. Use a generated id so downstream rows have something
      // stable.
      await client.api(`/users/${mailbox}/sendMail`).post(payload);
      const messageId = `outlook:${mailbox}:${Date.now()}:${randomSuffix()}`;
      this.logger.log(`outlook: sendMail -> ${input.toAddress} (id=${messageId})`);
      return { messageId, acceptedAt: new Date() };
    } catch (err) {
      throw new OutboundSendError(
        `Outlook Graph sendMail failed: ${err instanceof Error ? err.message : err}`,
        err,
      );
    }
  }

  async listInbound(sinceUtc: Date, limit = 50): Promise<InboundMessageSummary[]> {
    const { client, mailbox } = this.getClient();
    const filter = `receivedDateTime ge ${sinceUtc.toISOString()}`;
    const response = await client
      .api(`/users/${mailbox}/mailFolders/Inbox/messages`)
      .filter(filter)
      .top(limit)
      .orderby('receivedDateTime asc')
      .select('id,from,subject,receivedDateTime,bodyPreview')
      .get();
    const value: GraphInboxMessage[] = response?.value ?? [];
    return value.map((m) => ({
      outlookMessageId: m.id,
      fromAddress: m.from?.emailAddress?.address ?? '',
      subject: m.subject ?? null,
      receivedAt: new Date(m.receivedDateTime),
      bodyPreview: m.bodyPreview ?? undefined,
    }));
  }

  async getMessage(outlookMessageId: string): Promise<InboundMessageFull> {
    const { client, mailbox } = this.getClient();
    const m: GraphMessageDetail = await client
      .api(`/users/${mailbox}/messages/${outlookMessageId}`)
      .select('id,from,subject,receivedDateTime,bodyPreview,body')
      .get();
    const html = m.body?.contentType === 'html' ? m.body.content : null;
    const text =
      m.body?.contentType === 'text'
        ? m.body.content
        : html
          ? htmlToPlainText(html)
          : (m.bodyPreview ?? '');
    return {
      outlookMessageId: m.id,
      fromAddress: m.from?.emailAddress?.address ?? '',
      subject: m.subject ?? null,
      receivedAt: new Date(m.receivedDateTime),
      bodyPreview: m.bodyPreview ?? undefined,
      bodyText: text,
      bodyHtml: html,
    };
  }

  async markRead(outlookMessageId: string): Promise<void> {
    const { client, mailbox } = this.getClient();
    await client.api(`/users/${mailbox}/messages/${outlookMessageId}`).patch({ isRead: true });
  }

  async moveTo(outlookMessageId: string, folder: string): Promise<void> {
    const { client, mailbox } = this.getClient();
    await client
      .api(`/users/${mailbox}/messages/${outlookMessageId}/move`)
      .post({ destinationId: folder });
  }
}

interface GraphInboxMessage {
  id: string;
  from?: { emailAddress?: { address?: string } };
  subject?: string;
  receivedDateTime: string;
  bodyPreview?: string;
}

interface GraphMessageDetail extends GraphInboxMessage {
  body?: { contentType: 'html' | 'text'; content: string };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Outlook: ${name} env var is required`);
  return v;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
