import { Injectable } from '@nestjs/common';
import { CaseStatus } from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';

export type SenderMatch =
  | { kind: 'UNMATCHED'; normalisedEmail: string }
  | {
      kind: 'AMBIGUOUS';
      normalisedEmail: string;
      contacts: Array<{ contactId: string; organisationId: string }>;
    }
  | {
      kind: 'MATCHED';
      normalisedEmail: string;
      contactId: string;
      organisationId: string;
    };

/**
 * Sender → Contact resolution per docs/integrations.md §3.
 *
 * Matching against `Contact.primaryEmail` only for POC. Secondary-email
 * fallback (`emailsJson` scan) is a documented follow-up. The schema's
 * @@unique([organisationId, primaryEmail]) constraint allows the same
 * address across orgs, which is the "ambiguous sender" case.
 */
@Injectable()
export class InboundSenderMatcher {
  constructor(private readonly prisma: PrismaService) {}

  /** Lowercase, trim, strip plus-addressing (`local+anything@host` → `local@host`). */
  static normaliseEmail(raw: string): string {
    const trimmed = raw.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');
    if (at < 0) return trimmed;
    const local = trimmed.slice(0, at);
    const host = trimmed.slice(at);
    const plusIdx = local.indexOf('+');
    if (plusIdx >= 0) return `${local.slice(0, plusIdx)}${host}`;
    return trimmed;
  }

  async match(fromAddress: string): Promise<SenderMatch> {
    const normalisedEmail = InboundSenderMatcher.normaliseEmail(fromAddress);
    if (!normalisedEmail.includes('@')) {
      return { kind: 'UNMATCHED', normalisedEmail };
    }
    // Query on the indexed normalisedPrimaryEmail column so a reply
    // from "user@host" routes to a contact stored as "user+tag@host"
    // (and vice versa). Backfilled by the 20260526131047 migration;
    // tenancy-refresh keeps it in sync on every contact write.
    const matches = await this.prisma.contact.findMany({
      where: { normalisedPrimaryEmail: normalisedEmail },
      select: { id: true, organisationId: true },
    });
    if (matches.length === 0) return { kind: 'UNMATCHED', normalisedEmail };
    const [first, second] = matches;
    if (first && !second) {
      return {
        kind: 'MATCHED',
        normalisedEmail,
        contactId: first.id,
        organisationId: first.organisationId,
      };
    }
    return {
      kind: 'AMBIGUOUS',
      normalisedEmail,
      contacts: matches.map((m) => ({
        contactId: m.id,
        organisationId: m.organisationId,
      })),
    };
  }

  /** Active case (if any) for the contact's tenancies, scoped to its org. */
  async findActiveCaseForContact(
    contactId: string,
    organisationId: string,
  ): Promise<{ caseId: string } | null> {
    const tcs = await this.prisma.tenancyContact.findMany({
      where: { contactId },
      select: { tenancyId: true },
    });
    if (tcs.length === 0) return null;
    const active = await this.prisma.case.findFirst({
      where: {
        organisationId,
        tenancyId: { in: tcs.map((tc) => tc.tenancyId) },
        status: CaseStatus.ACTIVE,
      },
      select: { id: true },
    });
    return active ? { caseId: active.id } : null;
  }

  /**
   * Most-recent closed case for the contact's tenancies. Architecture
   * flow 3: "If no active case: store on closed case OR as case-less
   * message; do not invoke AI."
   */
  async findMostRecentClosedCaseForContact(
    contactId: string,
    organisationId: string,
  ): Promise<{ caseId: string } | null> {
    const tcs = await this.prisma.tenancyContact.findMany({
      where: { contactId },
      select: { tenancyId: true },
    });
    if (tcs.length === 0) return null;
    const closed = await this.prisma.case.findFirst({
      where: {
        organisationId,
        tenancyId: { in: tcs.map((tc) => tc.tenancyId) },
        status: CaseStatus.CLOSED,
      },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });
    return closed ? { caseId: closed.id } : null;
  }
}
