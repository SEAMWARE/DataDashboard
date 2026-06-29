import { Router } from 'express';
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import { Readable } from 'stream';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { logger } from '../services/logger.service.js';
import { externalRequest } from '../services/logger.service.js';
import type { ConnectorConfig, ConnectorUrlConfig } from '../services/config.service.js';
import { configService } from '../services/config.service.js';

export const CONNECTOR_SUBPATHS: ReadonlyArray<{ subPath: string; urlField: keyof ConnectorConfig }> = [
  { subPath: 'management',       urlField: 'managementUrl' },
  { subPath: 'default',          urlField: 'defaultUrl' },
  { subPath: 'protocol',         urlField: 'protocolUrl' },
  { subPath: 'federatedcatalog', urlField: 'federatedCatalogUrl' },
];

interface ReqData { start: [number, number]; url: string }
const reqData = new WeakMap<IncomingMessage, ReqData>();

const EDC_NS = 'https://w3id.org/edc/v0.0.1/ns/';
const SKIP_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'connection']);

function extractEdrField(edr: Record<string, unknown>, field: string): string | undefined {
  return (edr[field] ?? edr[`edc:${field}`] ?? edr[`${EDC_NS}${field}`]) as string | undefined;
}

async function handleEdrDownload(req: Request, res: Response, connector: ConnectorConfig, transferId: string): Promise<void> {
  const managementUrl = (connector.managementUrl as ConnectorUrlConfig | undefined)?.url;
  if (!managementUrl) {
    res.status(500).json({ error: 'No management URL configured for this connector' });
    return;
  }

  const edrUrl = `${managementUrl}/v3/edrs/${encodeURIComponent(transferId)}/dataaddress`;
  const edrRes = await fetch(edrUrl);
  if (!edrRes.ok) {
    const body = await edrRes.text();
    logger.error(`EDR fetch failed [${transferId}]: ${edrRes.status} ${body}`);
    res.status(edrRes.status).json({ error: 'Failed to fetch EDR data address' });
    return;
  }

  const edr = await edrRes.json() as Record<string, unknown>;
  const endpoint = extractEdrField(edr, 'endpoint');
  const authorization = extractEdrField(edr, 'authorization');

  if (!endpoint) {
    logger.error(`EDR for transfer ${transferId} has no endpoint field`);
    res.status(502).json({ error: 'EDR missing endpoint field' });
    return;
  }

  const targetUrl = new URL(endpoint);
  for (const [key, value] of Object.entries(req.query)) {
    targetUrl.searchParams.set(key, String(value));
  }

  const start = process.hrtime();
  const dataRes = await fetch(targetUrl.toString(), {
    headers: authorization ? { Authorization: authorization } : {},
  });
  externalRequest({ status: dataRes.status }, targetUrl.toString(), 'GET', start);

  res.status(dataRes.status);
  dataRes.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });

  if (dataRes.body) {
    Readable.fromWeb(dataRes.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    res.end();
  }
}

export function createProxyController(servers: Record<string, ConnectorConfig>): Router {
  const router = Router();
  const { proxyTimeout } = configService.get().server;

  router.get('/:connectorId/transfers/:transferId/download', (req, res) => {
    const { connectorId, transferId } = req.params;
    const connector = servers[connectorId];
    if (!connector) {
      res.status(404).json({ error: `Connector '${connectorId}' not found` });
      return;
    }
    handleEdrDownload(req, res, connector, transferId).catch(err => {
      logger.error(`EDR download error [${transferId}]: ${(err as Error).message}`);
      if (!res.headersSent) res.status(502).json({ error: 'Bad gateway', message: (err as Error).message });
    });
  });

  for (const [id, connector] of Object.entries(servers)) {
    for (const { subPath, urlField } of CONNECTOR_SUBPATHS) {
      const urlConfig = connector[urlField] as ConnectorUrlConfig | undefined;
      if (!urlConfig?.url || !urlConfig.proxy) continue;

      const parsed = new URL(urlConfig.url);
      const target = parsed.origin;
      const basePath = parsed.pathname === '/' ? '' : parsed.pathname;
      // Express strips the mount prefix before reaching the middleware, so the
      // path received is already relative (e.g. /v3/catalog/request). We only
      // need to prepend basePath — no need to match the original prefix.
      const pathRewrite = basePath ? { '^': basePath } : undefined;

      router.use(
        `/${id}/${subPath}`,
        createProxyMiddleware({
          target,
          changeOrigin: true,
          pathRewrite,
          proxyTimeout,
          on: {
            proxyReq: (proxyReq, req) => {
              reqData.set(req as IncomingMessage, {
                start: process.hrtime(),
                url: `${target}${proxyReq.path}`,
              });
            },
            proxyRes: (proxyRes, req) => {
              const data = reqData.get(req as IncomingMessage);
              if (data) {
                externalRequest({ status: proxyRes.statusCode ?? 0 }, data.url, req.method ?? 'GET', data.start);
                reqData.delete(req as IncomingMessage);
              }
            },
            error: (err, req, res) => {
              const data = reqData.get(req as IncomingMessage);
              if (data) {
                const durationHr = process.hrtime(data.start);
                const durationMs = (durationHr[0] * 1000 + durationHr[1] / 1e6).toFixed(2);
                logger.error(`Output ${(req as IncomingMessage).method?.toUpperCase()} ${data.url} ERROR ${durationMs}ms: ${err.message}`);
                reqData.delete(req as IncomingMessage);
              } else {
                logger.error(`Proxy error [${id}/${subPath}]: ${err.message}`);
              }
              (res as unknown as Response).status(502).json({ error: 'Bad gateway', id, message: err.message });
            },
          },
        }),
      );
      logger.info(`Proxy registered: /api/${id}/${subPath} -> ${urlConfig.url}`);
    }
  }

  return router;
}
