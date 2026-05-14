import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Buffer logs until Pino is wired up, then take over from the default logger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  await app.listen(port);

  app.get(Logger).log({ port }, 'arrears backend listening');
}

void bootstrap();
