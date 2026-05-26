import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import { decrypt, encrypt, loadKeyFromEnv } from '../credential-store/credential-crypto';
import { PrismaService } from '../prisma/prisma.service';

const SINGLETON_ID = 'default';

export interface ImapSmtpStatus {
  connected: boolean;
  mailboxAddress: string | null;
  imapHost: string | null;
  imapPort: number | null;
  smtpHost: string | null;
  smtpPort: number | null;
  connectedAt: string | null;
  connectedByUserId: string | null;
  lastUsedAt: string | null;
}

export interface ImapSmtpCredentials {
  mailboxAddress: string;
  appPassword: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

/**
 * Stores + uses the App-Password-based mailbox connection (Gmail,
 * Fastmail, etc.). Parallel to OutlookOAuthService — singleton row,
 * encrypted secret, no per-org state. The OutlookClient impl
 * ({@link ImapSmtpClient}) loads credentials through this service on
 * every call so a disconnect/reconnect takes effect without a restart.
 */
@Injectable()
export class ImapSmtpService {
  private readonly logger = new Logger(ImapSmtpService.name);

  constructor(private readonly prisma: PrismaService) {}

  async connect(opts: {
    mailboxAddress: string;
    appPassword: string;
    imapHost?: string;
    imapPort?: number;
    smtpHost?: string;
    smtpPort?: number;
    connectedByUserId: string;
  }): Promise<ImapSmtpStatus> {
    const creds: ImapSmtpCredentials = {
      mailboxAddress: opts.mailboxAddress,
      appPassword: opts.appPassword,
      imapHost: opts.imapHost ?? 'imap.gmail.com',
      imapPort: opts.imapPort ?? 993,
      smtpHost: opts.smtpHost ?? 'smtp.gmail.com',
      smtpPort: opts.smtpPort ?? 587,
    };
    // Probe both transports before persisting. Failing here means the
    // user gets immediate feedback ("App Password rejected") instead of
    // discovering it during the next sync.
    await this.probeImap(creds);
    await this.probeSmtp(creds);

    const key = loadKeyFromEnv();
    const data = {
      mailboxAddress: creds.mailboxAddress,
      imapHost: creds.imapHost,
      imapPort: creds.imapPort,
      smtpHost: creds.smtpHost,
      smtpPort: creds.smtpPort,
      appPasswordEncrypted: encrypt(creds.appPassword, key),
      connectedByUserId: opts.connectedByUserId,
    };
    await this.prisma.imapSmtpConnection.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    this.logger.log(
      `imap-smtp: connected mailbox=${creds.mailboxAddress} by=${opts.connectedByUserId}`,
    );
    return this.getStatus();
  }

  async getStatus(): Promise<ImapSmtpStatus> {
    const row = await this.prisma.imapSmtpConnection.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) {
      return {
        connected: false,
        mailboxAddress: null,
        imapHost: null,
        imapPort: null,
        smtpHost: null,
        smtpPort: null,
        connectedAt: null,
        connectedByUserId: null,
        lastUsedAt: null,
      };
    }
    return {
      connected: true,
      mailboxAddress: row.mailboxAddress,
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      connectedAt: row.connectedAt.toISOString(),
      connectedByUserId: row.connectedByUserId,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    };
  }

  async disconnect(): Promise<void> {
    await this.prisma.imapSmtpConnection.deleteMany({ where: { id: SINGLETON_ID } });
    this.logger.log('imap-smtp: disconnected');
  }

  /** Load creds for use by the ImapSmtpClient. Throws if not connected. */
  async loadCredentials(): Promise<ImapSmtpCredentials> {
    const row = await this.prisma.imapSmtpConnection.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) {
      throw new UnauthorizedException(
        'IMAP/SMTP mailbox not connected. Open the org config page and use the "IMAP/SMTP mailbox" card.',
      );
    }
    const key = loadKeyFromEnv();
    return {
      mailboxAddress: row.mailboxAddress,
      appPassword: decrypt(row.appPasswordEncrypted, key),
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
    };
  }

  async touchLastUsed(): Promise<void> {
    await this.prisma.imapSmtpConnection.updateMany({
      where: { id: SINGLETON_ID },
      data: { lastUsedAt: new Date() },
    });
  }

  /**
   * Build a connected IMAP client. Caller is responsible for `logout()`
   * in a finally block — IMAP keeps a TCP connection open per client,
   * so leaks add up fast.
   */
  async openImap(creds?: ImapSmtpCredentials): Promise<ImapFlow> {
    const c = creds ?? (await this.loadCredentials());
    const client = new ImapFlow({
      host: c.imapHost,
      port: c.imapPort,
      secure: true, // IMAPS — TLS from the start, not STARTTLS
      auth: { user: c.mailboxAddress, pass: c.appPassword },
      logger: false,
      // imapflow defaults are fine; explicit timeouts so a dead server
      // doesn't wedge a poll forever.
      socketTimeout: 30_000,
    });
    await client.connect();
    return client;
  }

  /** Build a nodemailer SMTP transport. Caller can `.close()` when done. */
  buildSmtpTransport(creds: ImapSmtpCredentials): Transporter {
    return nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      // Port 587 needs STARTTLS (not secure-on-connect). Port 465 would
      // be secure: true. Default to 587 since that's what Gmail/Fastmail use.
      secure: creds.smtpPort === 465,
      requireTLS: creds.smtpPort !== 465,
      auth: { user: creds.mailboxAddress, pass: creds.appPassword },
    });
  }

  private async probeImap(creds: ImapSmtpCredentials): Promise<void> {
    let client: ImapFlow | null = null;
    try {
      client = await this.openImap(creds);
    } catch (err) {
      throw new UnauthorizedException(
        `IMAP login failed (${creds.imapHost}:${creds.imapPort} as ${creds.mailboxAddress}): ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          // ignore — logout best-effort
        }
      }
    }
  }

  private async probeSmtp(creds: ImapSmtpCredentials): Promise<void> {
    const transport = this.buildSmtpTransport(creds);
    try {
      await transport.verify();
    } catch (err) {
      throw new UnauthorizedException(
        `SMTP login failed (${creds.smtpHost}:${creds.smtpPort} as ${creds.mailboxAddress}): ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      transport.close();
    }
  }
}
