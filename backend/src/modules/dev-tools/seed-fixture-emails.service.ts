import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CaseEventKind,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  type Prisma,
} from '@prisma/client';
import { Clock } from '../../common/clock/clock.service';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import {
  InboundPipelineService,
  type PipelineOutcome,
} from '../inbound/inbound-pipeline.service';
import { listFixtureEmlNames, loadFixtureEml } from './fixture-eml';

export interface SeedFixtureResult {
  fixture: string;
  communicationId: string;
  outcome: PipelineOutcome;
}

/**
 * Demo helper: drop a fixture inbound email onto a case and run the
 * inbound pipeline synchronously. The poll job is gated on
 * INBOUND_MODE=outlook for safety; this endpoint is the local-dev
 * shortcut so the review queue UI can be exercised without a real
 * mailbox or DB poking.
 *
 * The fixture's From header is overridden to the case's first tenant
 * Contact email (if any) so the sender → contact → firstName lookup
 * lands a real value in the classification prompt. Without a matched
 * Contact the prompt falls back to "the tenant".
 */
@Injectable()
export class SeedFixtureEmailsService {
  private readonly logger = new Logger(SeedFixtureEmailsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly pipeline: InboundPipelineService,
  ) {}

  listFixtures(): string[] {
    return listFixtureEmlNames();
  }

  async seedAll(caseId: string): Promise<SeedFixtureResult[]> {
    const names = listFixtureEmlNames();
    const results: SeedFixtureResult[] = [];
    for (const name of names) {
      results.push(await this.seedOne(caseId, name));
    }
    return results;
  }

  async seedOne(caseId: string, fixtureName: string): Promise<SeedFixtureResult> {
    const caseRow = await this.prisma.case.findUnique({
      where: { id: caseId },
      select: { id: true, organisationId: true, tenancyId: true },
    });
    if (!caseRow) {
      throw new NotFoundException(`Case ${caseId} not found`);
    }

    const fixture = loadFixtureEml(fixtureName);

    // Try to match the case's tenant Contact so the classifier prompt
    // gets a real first name. Fall back to the fixture's From otherwise.
    const tenantLink = await this.prisma.tenancyContact.findFirst({
      where: { tenancyId: caseRow.tenancyId, role: 'TENANT' },
      select: { contactId: true },
    });
    let fromAddress = fixture.fromAddress;
    if (tenantLink) {
      const contact = await this.prisma.contact.findUnique({
        where: { id: tenantLink.contactId },
        select: { primaryEmail: true },
      });
      if (contact?.primaryEmail) fromAddress = contact.primaryEmail;
    }

    const now = this.clock.now();
    const outlookMessageId = `dev:${fixture.fixtureName}:${now.getTime()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const comm = await this.prisma.communication.create({
      data: {
        caseId: caseRow.id,
        organisationId: caseRow.organisationId,
        direction: CommunicationDirection.INBOUND,
        channel: CommunicationChannel.EMAIL,
        status: CommunicationStatus.RECEIVED,
        fromAddress,
        receivedAt: now,
        outlookMessageId,
        subject: fixture.subject,
        rawBodyText: fixture.bodyText,
      },
    });
    await this.prisma.caseEvent.create({
      data: {
        caseId: caseRow.id,
        kind: CaseEventKind.COMMUNICATION_RECEIVED,
        payloadJson: {
          communicationId: comm.id,
          fromAddress,
          fixtureName: fixture.fixtureName,
          source: 'dev-tools:seed-fixture-emails',
        } as Prisma.InputJsonValue,
        occurredAt: now,
      },
    });

    const outcome = await this.pipeline.handle(comm.id);
    this.logger.log(
      `seed-fixture-emails: case=${caseId} fixture=${fixture.fixtureName} ` +
        `commId=${comm.id} outcome=${outcome.status}`,
    );
    return { fixture: fixture.fixtureName, communicationId: comm.id, outcome };
  }
}
