export interface OutboundSendInput {
  toAddress: string;
  subject: string;
  bodyMarkdown: string;
}

export interface OutboundSendResult {
  /** Provider-specific message identifier (SMTP message-id or Graph id). */
  messageId: string;
  acceptedAt: Date;
}

export class OutboundSendError extends Error {
  public readonly causeReason: unknown;
  constructor(message: string, causeReason?: unknown) {
    super(message);
    this.name = 'OutboundSendError';
    this.causeReason = causeReason;
  }
}

/** Phase 7 inbound shapes — placeholder, filled in when the poll lands. */
export interface InboundMessageSummary {
  outlookMessageId: string;
  fromAddress: string;
  subject: string | null;
  receivedAt: Date;
  bodyPreview?: string;
}

export interface InboundMessageFull extends InboundMessageSummary {
  bodyText: string;
  bodyHtml: string | null;
}

export interface OutboundMailer {
  sendMail(input: OutboundSendInput): Promise<OutboundSendResult>;
}

export interface InboundMailReader {
  listInbound(sinceUtc: Date, limit?: number): Promise<InboundMessageSummary[]>;
  getMessage(outlookMessageId: string): Promise<InboundMessageFull>;
  markRead(outlookMessageId: string): Promise<void>;
  moveTo(outlookMessageId: string, folder: string): Promise<void>;
}

export interface OutlookClient extends OutboundMailer, InboundMailReader {}

export const OUTLOOK_CLIENT = Symbol('OUTLOOK_CLIENT');
