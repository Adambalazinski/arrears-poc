import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { graphApiMock, postMock, getMock, patchMock } = vi.hoisted(() => {
  const post = vi.fn();
  const get = vi.fn();
  const patch = vi.fn();
  const apiFluent = {
    filter: vi.fn().mockReturnThis(),
    top: vi.fn().mockReturnThis(),
    orderby: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    post,
    get,
    patch,
  };
  const apiMock = vi.fn(() => apiFluent);
  return { graphApiMock: apiMock, postMock: post, getMock: get, patchMock: patch };
});

vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: {
    initWithMiddleware: () => ({ api: graphApiMock }),
  },
}));
vi.mock('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials', () => ({
  TokenCredentialAuthenticationProvider: class {},
}));
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    constructor(public readonly tenantId: string, public readonly clientId: string, public readonly secret: string) {}
  },
}));

import { OutlookGraphClient } from '../outlook-graph-client';
import { OutboundSendError } from '../outlook.types';

beforeEach(() => {
  graphApiMock.mockClear();
  postMock.mockReset();
  getMock.mockReset();
  patchMock.mockReset();
  vi.stubEnv('OUTLOOK_TENANT_ID', 'tenant');
  vi.stubEnv('OUTLOOK_CLIENT_ID', 'client');
  vi.stubEnv('OUTLOOK_CLIENT_SECRET', 'secret');
  vi.stubEnv('OUTLOOK_SHARED_MAILBOX', 'arrears@example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OutlookGraphClient.sendMail', () => {
  it('posts to /users/{mailbox}/sendMail with HTML body + saveToSentItems', async () => {
    postMock.mockResolvedValue(undefined);
    const client = new OutlookGraphClient();
    const r = await client.sendMail({
      toAddress: 't@x.com',
      subject: 's',
      bodyMarkdown: 'Hello **bold**',
    });
    expect(r.messageId).toMatch(/^outlook:arrears@example\.com:/);
    expect(graphApiMock).toHaveBeenCalledWith('/users/arrears@example.com/sendMail');
    const payload = postMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      saveToSentItems: true,
      message: {
        subject: 's',
        body: { contentType: 'HTML' },
        toRecipients: [{ emailAddress: { address: 't@x.com' } }],
      },
    });
    const body = (payload.message as { body: { content: string } }).body.content;
    expect(body).toContain('<strong>bold</strong>');
  });

  it('wraps Graph errors in OutboundSendError', async () => {
    postMock.mockRejectedValue(new Error('Insufficient privileges'));
    const client = new OutlookGraphClient();
    await expect(
      client.sendMail({ toAddress: 't', subject: 's', bodyMarkdown: 'b' }),
    ).rejects.toBeInstanceOf(OutboundSendError);
  });

  it('listInbound queries mailFolders/Inbox/messages with the receivedDateTime filter', async () => {
    getMock.mockResolvedValue({
      value: [
        {
          id: 'msg-1',
          from: { emailAddress: { address: 'a@x.com' } },
          subject: 'Hello',
          receivedDateTime: '2026-05-15T08:00:00Z',
          bodyPreview: 'preview',
        },
      ],
    });
    const client = new OutlookGraphClient();
    const since = new Date('2026-05-15T07:00:00Z');
    const out = await client.listInbound(since, 50);
    expect(graphApiMock).toHaveBeenCalledWith(
      '/users/arrears@example.com/mailFolders/Inbox/messages',
    );
    expect(out).toEqual([
      {
        outlookMessageId: 'msg-1',
        fromAddress: 'a@x.com',
        subject: 'Hello',
        receivedAt: new Date('2026-05-15T08:00:00Z'),
        bodyPreview: 'preview',
      },
    ]);
  });

  it('getMessage prefers HTML body and falls back to bodyPreview for plain text', async () => {
    getMock.mockResolvedValue({
      id: 'msg-1',
      from: { emailAddress: { address: 'a@x.com' } },
      subject: 'Hello',
      receivedDateTime: '2026-05-15T08:00:00Z',
      body: { contentType: 'html', content: '<p>Hi <b>there</b></p>' },
      bodyPreview: 'Hi there',
    });
    const client = new OutlookGraphClient();
    const m = await client.getMessage('msg-1');
    expect(m.bodyHtml).toContain('<p>Hi');
    expect(m.bodyText).toContain('Hi there');
  });

  it('markRead PATCHes isRead: true and moveTo POSTs destinationId', async () => {
    patchMock.mockResolvedValue(undefined);
    postMock.mockResolvedValue(undefined);
    const client = new OutlookGraphClient();
    await client.markRead('msg-1');
    expect(patchMock).toHaveBeenCalledWith({ isRead: true });
    await client.moveTo('msg-1', 'Processed');
    expect(postMock).toHaveBeenCalledWith({ destinationId: 'Processed' });
  });

  it('refuses to initialise without OUTLOOK_* env vars', async () => {
    vi.unstubAllEnvs();
    const client = new OutlookGraphClient();
    await expect(
      client.sendMail({ toAddress: 't', subject: 's', bodyMarkdown: 'b' }),
    ).rejects.toThrow(/OUTLOOK_TENANT_ID env var is required/);
  });
});
