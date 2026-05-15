import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { htmlToPlainText, renderMarkdownToHtml } from './markdown-to-html';
import {
  OutboundSendError,
  type InboundMessageFull,
  type InboundMessageSummary,
  type OutboundSendInput,
  type OutboundSendResult,
  type OutlookClient,
} from './outlook.types';

/**
 * Local dev / OUTBOUND_MODE=mailhog: pipe outbound mail to nodemailer over
 * SMTP at localhost:1025. Mailhog catches everything and exposes the UI on
 * :8025. Inbound methods are not supported — the inbound poll uses the
 * real Graph client (or fixtures via INTEGRATION_MODE).
 */
@Injectable()
export class MailhogMailer implements OutlookClient {
  private readonly logger = new Logger(MailhogMailer.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(host = 'localhost', port = 1025) {
    this.transporter = nodemailer.createTransport({
      host,
      port,
      // Mailhog speaks plain SMTP with no auth.
      secure: false,
      auth: undefined,
      ignoreTLS: true,
    });
    this.from =
      process.env.OUTLOOK_SHARED_MAILBOX ?? 'arrears-poc@localhost';
  }

  async sendMail(input: OutboundSendInput): Promise<OutboundSendResult> {
    const html = renderMarkdownToHtml(input.bodyMarkdown);
    const text = htmlToPlainText(html);
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: input.toAddress,
        subject: input.subject,
        html,
        text,
      });
      this.logger.log(`mailhog: sent ${info.messageId} -> ${input.toAddress}`);
      return { messageId: info.messageId, acceptedAt: new Date() };
    } catch (err) {
      throw new OutboundSendError(
        `Mailhog SMTP send failed: ${err instanceof Error ? err.message : err}`,
        err,
      );
    }
  }

  listInbound(): Promise<InboundMessageSummary[]> {
    return Promise.reject(
      new Error('MailhogMailer.listInbound: inbound polling goes through Outlook Graph, not Mailhog'),
    );
  }

  getMessage(): Promise<InboundMessageFull> {
    return Promise.reject(new Error('MailhogMailer.getMessage: not supported'));
  }

  markRead(): Promise<void> {
    return Promise.reject(new Error('MailhogMailer.markRead: not supported'));
  }

  moveTo(): Promise<void> {
    return Promise.reject(new Error('MailhogMailer.moveTo: not supported'));
  }
}
