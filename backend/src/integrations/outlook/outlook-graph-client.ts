import { ClientSecretCredential } from '@azure/identity';
import { Client, type AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { Injectable, Logger } from '@nestjs/common';
import { htmlToPlainText, renderMarkdownToHtml } from './markdown-to-html';
import { OutlookOAuthService } from './outlook-oauth.service';
import {
  OutboundSendError,
  type InboundMessageFull,
  type InboundMessageSummary,
  type OutboundSendInput,
  type OutboundSendResult,
  type OutlookClient,
} from './outlook.types';

const GRAPH_SCOPES = ['https://graph.microsoft.com/.default'];

/**
 * OUTLOOK_AUTH switch:
 *   - "delegated" (default): use the singleton OutlookOAuthConnection
 *     row (refresh-token-driven). User clicks "Connect Outlook", the
 *     mailbox UPN comes from the stored state. Bypasses the
 *     RBAC-for-Apps wall.
 *   - "app": use ClientSecretCredential with env vars (production
 *     path). Needs Mail.Send/Mail.ReadWrite **Application** permissions
 *     bound to a mailbox via Application Access Policy / RBAC-for-Apps.
 */
function authMode(): 'delegated' | 'app' {
  const v = (process.env.OUTLOOK_AUTH ?? 'delegated').toLowerCase();
  if (v === 'app' || v === 'delegated') return v;
  throw new Error(`Unknown OUTLOOK_AUTH="${v}" (expected delegated or app)`);
}

/**
 * Microsoft Graph SDK calls `getAccessToken()` before every request.
 * For delegated mode we delegate (no pun intended) to OutlookOAuthService,
 * which handles refresh-on-demand against the stored refresh token.
 */
class DelegatedAuthProvider implements AuthenticationProvider {
  constructor(private readonly oauth: OutlookOAuthService) {}
  async getAccessToken(): Promise<string> {
    const clientId = requireEnv('OUTLOOK_CLIENT_ID');
    const clientSecret = requireEnv('OUTLOOK_CLIENT_SECRET');
    return this.oauth.getValidAccessToken({ clientId, clientSecret });
  }
}

@Injectable()
export class OutlookGraphClient implements OutlookClient {
  private readonly logger = new Logger(OutlookGraphClient.name);
  private cached?: { client: Client; mailbox: () => Promise<string> };

  constructor(private readonly oauth: OutlookOAuthService) {}

  /**
   * Lazy init — the client is only constructed on first call. Lets
   * Mailhog mode run without OUTLOOK_* env vars being set.
   */
  private getClient(): { client: Client; mailbox: () => Promise<string> } {
    if (this.cached) return this.cached;
    const mode = authMode();
    if (mode === 'delegated') {
      const client = Client.initWithMiddleware({
        authProvider: new DelegatedAuthProvider(this.oauth),
      });
      // Mailbox UPN comes from the stored connection (set during OAuth
      // consent), not from env. Re-read on each call so a Reconnect
      // takes effect without a backend restart.
      const mailbox = async (): Promise<string> => {
        const status = await this.oauth.getStatus();
        if (!status.connected || !status.mailboxUpn) {
          throw new Error(
            'Outlook is not connected — click "Connect Outlook" in the UI first',
          );
        }
        return status.mailboxUpn;
      };
      this.cached = { client, mailbox };
      return this.cached;
    }
    // App-credentials mode — kept for tenants where RBAC-for-Apps is
    // configured. Identical to what we had before.
    const tenantId = requireEnv('OUTLOOK_TENANT_ID');
    const clientId = requireEnv('OUTLOOK_CLIENT_ID');
    const clientSecret = requireEnv('OUTLOOK_CLIENT_SECRET');
    const sharedMailbox = requireEnv('OUTLOOK_SHARED_MAILBOX');
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: GRAPH_SCOPES,
    });
    const client = Client.initWithMiddleware({ authProvider });
    this.cached = { client, mailbox: async () => sharedMailbox };
    return this.cached;
  }

  async sendMail(input: OutboundSendInput): Promise<OutboundSendResult> {
    const { client, mailbox: getMailbox } = this.getClient();
    const mailbox = await getMailbox();
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
    const { client, mailbox: getMailbox } = this.getClient();
    const mailbox = await getMailbox();
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
    const { client, mailbox: getMailbox } = this.getClient();
    const mailbox = await getMailbox();
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
    const { client, mailbox: getMailbox } = this.getClient();
    const mailbox = await getMailbox();
    await client.api(`/users/${mailbox}/messages/${outlookMessageId}`).patch({ isRead: true });
  }

  async moveTo(outlookMessageId: string, folder: string): Promise<void> {
    const { client, mailbox: getMailbox } = this.getClient();
    const mailbox = await getMailbox();
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
