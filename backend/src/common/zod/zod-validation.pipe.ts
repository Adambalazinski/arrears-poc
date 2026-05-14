import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';

/**
 * Minimal Zod -> NestJS pipe. Use as `new ZodBody(SomeSchema)` in a controller:
 *   @Post() create(@Body(new ZodBody(CreateOrganisationSchema)) dto: CreateDto)
 *
 * Throws 400 with the Zod issues serialised in `details`.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid request body',
        details: flattenZodIssues(parsed.error),
      });
    }
    return parsed.data;
  }
}

function flattenZodIssues(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
