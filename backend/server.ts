import express from 'express';
import cors from 'cors';
import { join } from 'path';
import { configService } from './services/config.service.js';
import { logger, requestLogger } from './services/logger.service.js';
import { createProxyController } from './controllers/proxy.controller.js';
import { createConfigController } from './controllers/config.controller.js';

const config = configService.get();
const { server: serverConfig, connectors } = config;

if (!connectors || typeof connectors !== 'object') {
  logger.error('config must have a "connectors" key with connector objects');
  process.exit(1);
}

const app = express();

app.set('trust proxy', serverConfig.trustProxy);

app.use(cors({
  origin: serverConfig.cors.origin,
  methods: serverConfig.cors.methods,
  allowedHeaders: serverConfig.cors.allowedHeaders,
  credentials: serverConfig.cors.credentials,
  optionsSuccessStatus: serverConfig.cors.optionsSuccessStatus,
  maxAge: serverConfig.cors.maxAge,
}));

app.use(requestLogger);

// Proxy must come before express.json — body parser consumes the stream and
// the proxy would forward an empty body to the connector.
app.use('/api', createProxyController(connectors));

app.use(express.json({ limit: serverConfig.jsonBodyLimit }));
app.use('/config', createConfigController());

const STATIC_DIR = process.env.STATIC_DIR ?? join(process.cwd(), serverConfig.staticPath);
app.use(express.static(STATIC_DIR));

app.get('*', (_req, res) => {
  res.sendFile(join(STATIC_DIR, 'index.html'));
});

const PORT = process.env.PORT ?? serverConfig.port;
const httpServer = app.listen(PORT, () => {
  logger.info(`Server listening on http://localhost:${PORT}`);
});

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down gracefully`);

  httpServer.close((err) => {
    if (err) {
      logger.error(`Error during shutdown: ${err.message}`);
      process.exit(1);
    }
    logger.info('All connections closed, exiting');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
