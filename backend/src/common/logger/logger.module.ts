import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // Always JSON: structured logs are the contract for the demo, and pretty
        // printing in dev is a CLI choice (`pnpm dev | pino-pretty`).
        level: (process.env.LOG_LEVEL ?? 'info').toLowerCase(),
        // Per-request id. Trust an incoming `x-request-id` if present so traces
        // can be correlated, otherwise generate one.
        genReqId: (req: IncomingMessage) => {
          const incoming = req.headers['x-request-id'];
          if (typeof incoming === 'string' && incoming.length > 0) return incoming;
          return randomUUID();
        },
        customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        customSuccessMessage: (req, res, responseTime) =>
          `${req.method} ${req.url} -> ${res.statusCode} (${responseTime}ms)`,
        customErrorMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode} (error)`,
        serializers: {
          req(req: IncomingMessage & { id?: string; method?: string; url?: string }) {
            return { id: req.id, method: req.method, url: req.url };
          },
          res(res: ServerResponse) {
            return { statusCode: res.statusCode };
          },
        },
        base: { service: 'arrears-backend' },
      },
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
