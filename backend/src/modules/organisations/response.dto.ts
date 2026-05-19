import { ApiProperty } from '@nestjs/swagger';

/**
 * Wire-shape of an Organisation row. Dates are ISO 8601 strings (BigInt
 * money fields, where they appear elsewhere, are also strings — see the
 * BigInt#toJSON override in main.ts). The Prisma row type isn't usable
 * directly because the @nestjs/swagger CLI plugin reflects on classes, not
 * type aliases.
 */
export class OrganisationResponseDto {
  @ApiProperty({ type: String, example: 'demo-org' })
  id!: string;

  @ApiProperty({ type: String, example: 'Demo Lettings Ltd' })
  name!: string;

  /** ISO 8601 timestamp. */
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  /** ISO 8601 timestamp. */
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}
