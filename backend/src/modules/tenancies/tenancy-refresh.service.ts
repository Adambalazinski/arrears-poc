import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Prisma } from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import {
  RentancyNotFoundError,
  RENTANCY_CLIENT,
  type RentancyTenancyClient,
} from '../../integrations/rentancy/rentancy.client';

export interface RentancyRefreshResult {
  tenancyId: string;
  contactsRefreshed: number;
  notFound: boolean;
}

/**
 * Pulls a tenancy + its contacts from Rentancy and writes them into the
 * canonical Tenancy / Contact / TenancyContact tables. Two callers:
 *   - the LWCA poll job, on case open (one-shot enrichment)
 *   - the hourly RentancyTenancyRefreshJob (steady-state freshness)
 *
 * Preserves LWCA-owned fields on Tenancy (property name + addresses).
 * Removes TenancyContact join rows that are no longer present upstream.
 */
@Injectable()
export class TenancyRefreshService {
  private readonly logger = new Logger(TenancyRefreshService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RENTANCY_CLIENT) private readonly rentancy: RentancyTenancyClient,
  ) {}

  async refreshFromRentancy(
    organisationId: string,
    tenancyId: string,
  ): Promise<RentancyRefreshResult> {
    let tenancy;
    try {
      tenancy = await this.rentancy.getTenancy(organisationId, tenancyId);
    } catch (err) {
      if (err instanceof RentancyNotFoundError) {
        // Tenants and tenancies get deleted upstream. Per docs/integrations.md
        // "log, mark missing on the case, do not halt polling".
        this.logger.warn(`rentancy refresh: tenancy ${tenancyId} not found upstream`);
        return { tenancyId, contactsRefreshed: 0, notFound: true };
      }
      throw err;
    }

    const allContactIds = Array.from(
      new Set([...tenancy.tenantContactIds, ...tenancy.guarantorContactIds]),
    );

    // Fetch all contacts in parallel; tolerate individual NOT_FOUND so a
    // dangling tenant id doesn't fail the whole refresh.
    const contacts = await Promise.all(
      allContactIds.map(async (id) => {
        try {
          return await this.rentancy.getContact(organisationId, id);
        } catch (err) {
          if (err instanceof RentancyNotFoundError) {
            this.logger.warn(`rentancy refresh: contact ${id} not found upstream`);
            return null;
          }
          throw err;
        }
      }),
    );

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.tenancy.upsert({
        where: { id: tenancyId },
        create: {
          id: tenancyId,
          organisationId,
          propertyId: tenancy.propertyId,
          status: tenancy.status,
          reference: tenancy.reference,
          rentDayOfMonth: tenancy.rentDayOfMonth,
          rentAmountPence: tenancy.rentAmountPence,
          lastSyncedAt: now,
        },
        update: {
          // Preserve property display fields LWCA owns (propertyName /
          // Address1 / Address2) — only update what Rentancy is canonical for.
          propertyId: tenancy.propertyId,
          status: tenancy.status,
          reference: tenancy.reference,
          rentDayOfMonth: tenancy.rentDayOfMonth,
          rentAmountPence: tenancy.rentAmountPence,
          lastSyncedAt: now,
        },
      });

      for (const c of contacts) {
        if (!c) continue;
        await tx.contact.upsert({
          where: { id: c.contactId },
          create: {
            id: c.contactId,
            organisationId,
            firstName: c.firstName,
            lastName: c.lastName,
            companyName: c.companyName,
            primaryEmail: c.primaryEmail,
            emailsJson: c.emailsJson as unknown as Prisma.InputJsonValue,
            phonesJson: c.phonesJson as unknown as Prisma.InputJsonValue,
            lastSyncedAt: now,
          },
          update: {
            firstName: c.firstName,
            lastName: c.lastName,
            companyName: c.companyName,
            primaryEmail: c.primaryEmail,
            emailsJson: c.emailsJson as unknown as Prisma.InputJsonValue,
            phonesJson: c.phonesJson as unknown as Prisma.InputJsonValue,
            lastSyncedAt: now,
          },
        });
      }

      // Reconcile TenancyContact join rows: add new ones, remove rows for
      // contacts no longer on this tenancy. Dangling contact ids (Rentancy
      // listed them on the tenancy but the contact itself 404s) are
      // dropped here — the FK to Contact would reject them anyway.
      const resolvedIds = new Set(
        contacts.filter((c): c is NonNullable<typeof c> => c != null).map((c) => c.contactId),
      );
      const desired: Array<{ contactId: string; role: 'TENANT' | 'GUARANTOR' }> = [
        ...tenancy.tenantContactIds
          .filter((id) => resolvedIds.has(id))
          .map((id) => ({ contactId: id, role: 'TENANT' as const })),
        ...tenancy.guarantorContactIds
          .filter((id) => resolvedIds.has(id))
          .map((id) => ({ contactId: id, role: 'GUARANTOR' as const })),
      ];

      const desiredKeys = new Set(desired.map((d) => `${d.contactId}::${d.role}`));

      const existing = await tx.tenancyContact.findMany({ where: { tenancyId } });
      for (const link of existing) {
        const k = `${link.contactId}::${link.role}`;
        if (!desiredKeys.has(k)) {
          await tx.tenancyContact.delete({
            where: {
              tenancyId_contactId_role: {
                tenancyId,
                contactId: link.contactId,
                role: link.role,
              },
            },
          });
        }
      }

      for (const d of desired) {
        await tx.tenancyContact.upsert({
          where: {
            tenancyId_contactId_role: {
              tenancyId,
              contactId: d.contactId,
              role: d.role,
            },
          },
          create: { tenancyId, contactId: d.contactId, role: d.role },
          update: {},
        });
      }
    });

    return {
      tenancyId,
      contactsRefreshed: contacts.filter((c) => c != null).length,
      notFound: false,
    };
  }
}
