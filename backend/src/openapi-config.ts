import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Single source of truth for the OpenAPI document metadata. Used by both
 * the export script and the in-process Swagger UI mount in main.ts.
 */
export function buildOpenApiConfig(): ReturnType<DocumentBuilder['build']> {
  return new DocumentBuilder()
    .setTitle('Arrears POC API')
    .setDescription(
      'Internal HTTP API for the Arrears chasing application. Local POC against LWCA stage.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .build();
}
