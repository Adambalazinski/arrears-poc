import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.hoisted(() => vi.fn());

vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: sendMailMock }),
}));

import { MailhogMailer } from '../mailhog-mailer';
import { OutboundSendError } from '../outlook.types';

beforeEach(() => {
  sendMailMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MailhogMailer.sendMail', () => {
  it('renders markdown to HTML, attaches plain-text fallback, and posts to SMTP', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<smtp-id@mailhog>' });
    const mailer = new MailhogMailer();
    const result = await mailer.sendMail({
      toAddress: 'jane@example.com',
      subject: 'Outstanding rent',
      bodyMarkdown: '# Hi Jane\n\nPlease pay £1,200.',
    });
    expect(result.messageId).toBe('<smtp-id@mailhog>');
    expect(result.acceptedAt).toBeInstanceOf(Date);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const args = sendMailMock.mock.calls[0]![0] as Record<string, string>;
    expect(args.to).toBe('jane@example.com');
    expect(args.subject).toBe('Outstanding rent');
    expect(args.html).toContain('<h1>Hi Jane</h1>');
    expect(args.html).toContain('£1,200');
    expect(args.text).toContain('Hi Jane');
    expect(args.text).not.toContain('<h1>');
  });

  it('uses OUTLOOK_SHARED_MAILBOX as the From address when set', async () => {
    vi.stubEnv('OUTLOOK_SHARED_MAILBOX', 'arrears-test@lofty.example');
    sendMailMock.mockResolvedValue({ messageId: '<x>' });
    await new MailhogMailer().sendMail({
      toAddress: 't@x.com',
      subject: 's',
      bodyMarkdown: 'b',
    });
    const args = sendMailMock.mock.calls[0]![0] as Record<string, string>;
    expect(args.from).toBe('arrears-test@lofty.example');
  });

  it('wraps SMTP errors in OutboundSendError', async () => {
    sendMailMock.mockRejectedValue(new Error('ECONNREFUSED 1025'));
    const mailer = new MailhogMailer();
    await expect(
      mailer.sendMail({ toAddress: 't', subject: 's', bodyMarkdown: 'b' }),
    ).rejects.toBeInstanceOf(OutboundSendError);
  });

  it('inbound methods reject — Mailhog cannot be polled', async () => {
    const mailer = new MailhogMailer();
    await expect(mailer.listInbound()).rejects.toThrow(/inbound polling goes through Outlook Graph/);
    await expect(mailer.getMessage()).rejects.toThrow(/not supported/);
    await expect(mailer.markRead()).rejects.toThrow(/not supported/);
    await expect(mailer.moveTo()).rejects.toThrow(/not supported/);
  });
});
