import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildOpenApiConfig } from './openapi-config';

// Money is BigInt (pence) end-to-end per CLAUDE.md. JSON.stringify chokes on
// BigInt by default — serialise as a string and let the client parse.
// Done once, at process start, so every Nest response is correct.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  // Buffer logs until Pino is wired up, then take over from the default logger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  if (process.env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(app, buildOpenApiConfig());
    SwaggerModule.setup('api-docs', app, doc);
  }

  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  await app.listen(port);

  app.get(Logger).log({ port }, 'arrears backend listening');
}

void bootstrap();
