import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, LogLevel } from '@nestjs/common';
import { AppModule } from './app.module';

const ALL_LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

function resolveLogLevels(): LogLevel[] {
  const raw = (process.env.LOG_LEVEL ?? 'log').toLowerCase();
  const min = raw === 'info' ? 'log' : raw; // accept the common alias
  const idx = ALL_LEVELS.indexOf(min as LogLevel);
  if (idx < 0) return ['log', 'warn', 'error', 'fatal'];
  return ALL_LEVELS.slice(idx);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: resolveLogLevels(),
  });

  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  await app.listen(port);

  Logger.log(`Arrears backend listening on :${port}`, 'Bootstrap');
}

void bootstrap();
