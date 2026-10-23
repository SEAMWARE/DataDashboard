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

// `Response` is Express's in this file, so name fetch's own return type explicitly.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

interface ReqData { start: [number, number]; url: string }
const reqData = new WeakMap<IncomingMessage, ReqData>();

const EDC_NS = 'https://w3id.org/edc/v0.0.1/ns/';
const SKIP_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'connection']);

function extractField(source: Record<string, unknown>, field: string): string | undefined {
  return (source[field] ?? source[`edc:${field}`] ?? source[`${EDC_NS}${field}`]) as string | undefined;
}

/**
 * The id of the contract agreement the transfer was started from, read off the transfer process.
 *
 * Some provider data planes require it as a `Contract-Id` header on every pull, on top of the
 * EDR token, and fail before authorization when it is missing - one such implementation answers
 * a bare `HTTP 500 Request failed.` with or without the token, which is indistinguishable from
 * the provider being down. It is not carried in the EDR, so it has to be fetched separately.
 * Providers that do not expect the header ignore it, so it is always sent.
 *
 * A failure here is not fatal: the pull is attempted without the header, exactly as before.
 */
async function fetchContractAgreementId(managementUrl: string, transferId: string): Promise<string | undefined> {
  const url = `${managementUrl}/v3/transferprocesses/${encodeURIComponent(transferId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.warn(`Transfer process fetch failed [${transferId}]: ${res.status} - pulling without Contract-Id`);
    return undefined;
  }
  const transferProcess = await res.json() as Record<string, unknown>;
  const contractId = extractField(transferProcess, 'contractId');
  if (!contractId) {
    logger.warn(`Transfer process ${transferId} has no contractId - pulling without Contract-Id`);
  }
  return contractId;
}

function normalizeBearer(token: string | undefined): string | undefined {
  return token?.toLowerCase().startsWith('bearer') ? token : `Bearer ${token}`;
}

/**
 * GETs the data endpoint, trying both ways of presenting the EDR token.
 *
 * There is no reliable signal for which one a provider wants. EDC's own data plane public API
 * reads `Authorization` as the raw token, while a gateway-fronted data plane - APISIX with the
 * OIDC plugin in `bearer_only` mode, for instance - requires the `Bearer` scheme. `authType`
 * does not tell them apart: a provider can declare `bearer` and still reject the prefix with
 * `403 {"errors":["Failed to decode token"]}`, which is what sent us chasing the wrong problem.
 *
 * So the raw token is tried first, as that is what EDC itself expects, and the prefixed form is
 * retried only on 401/403. The request is a GET, so a second attempt is free of side effects.
 */
async function pullWithTokenFallback(
  url: string,
  baseHeaders: Record<string, string>,
  authorization: string | undefined,
  tokenHeader: string | undefined,
): Promise<FetchResponse> {
  const candidates = authorization
    ? [...new Set([authorization, tokenHeader].filter((t): t is string => !!t))]
    : [undefined];

  let response!: FetchResponse;
  for (const [index, token] of candidates.entries()) {
    const headers = token ? { ...baseHeaders, Authorization: token } : { ...baseHeaders };
    const start = process.hrtime();
    response = await fetch(url, { headers });
    externalRequest({ status: response.status }, url, 'GET', start);

    const retryable = response.status === 401 || response.status === 403;
    if (!retryable || index === candidates.length - 1) return response;

    logger.warn(`Data pull rejected with ${response.status}; retrying with the other Authorization form`);
    await response.body?.cancel();
  }
  return response;
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
  const endpoint = extractField(edr, 'endpoint');
  const authorization = extractField(edr, 'authorization');
  const isBearer = extractField(edr, 'authType') === 'bearer';
  const tokenHeader = isBearer ? normalizeBearer(authorization) : authorization;
  if (!endpoint) {
    logger.error(`EDR for transfer ${transferId} has no endpoint field`);
    res.status(502).json({ error: 'EDR missing endpoint field' });
    return;
  }

  const targetUrl = new URL(endpoint);
  for (const [key, value] of Object.entries(req.query)) {
    targetUrl.searchParams.set(key, String(value));
  }

  const contractId = await fetchContractAgreementId(managementUrl, transferId);

  const baseHeaders: Record<string, string> = {};
  if (contractId) baseHeaders['Contract-Id'] = contractId;

  const dataRes = await pullWithTokenFallback(targetUrl.toString(), baseHeaders, authorization, tokenHeader);

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
