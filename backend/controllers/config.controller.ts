import { Router } from 'express';
import type { Request, Response } from 'express';
import { join } from 'path';
import type { ConnectorUrlConfig } from '../services/config.service.js';
import { configService } from '../services/config.service.js';
import { CONNECTOR_SUBPATHS } from './proxy.controller.js';

const STATIC_CONFIG_DIR = join(process.cwd(), 'static/config');

// When trust proxy is enabled Express resolves X-Forwarded-Proto into req.protocol
// and X-Forwarded-Host into req.hostname. We reconstruct the full origin from those.
function resolveServerBase(req: Request): string {
  const proto = req.protocol;
  const forwardedHost = req.get('X-Forwarded-Host');
  if (forwardedHost) {
    // Behind a proxy: X-Forwarded-Host usually has no port, X-Forwarded-Port carries it separately
    const port = req.get('X-Forwarded-Port');
    const isDefaultPort = (proto === 'https' && port === '443') || (proto === 'http' && port === '80');
    return `${proto}://${forwardedHost}${port && !isDefaultPort ? `:${port}` : ''}`;
  }
  // Direct connection: Host header already includes the port when non-standard (e.g. localhost:8080)
  return `${proto}://${req.get('host')}`;
}

export function createConfigController(): Router {
  const router = Router();

  router.get('/APP_BASE_HREF.txt', (req: Request, res: Response) => {
    const { server } = configService.get();
    const serverBase = server.publicUrl ?? resolveServerBase(req);
    res.type('text/plain').send(serverBase);
  });

  router.get('/app-config.json', (_req: Request, res: Response) => {
    res.sendFile(join(STATIC_CONFIG_DIR, 'app-config.json'));
  });

  router.get('/edc-connector-config.json', (req: Request, res: Response) => {
    const { connectors, server } = configService.get();
    const serverBase = server.publicUrl ?? resolveServerBase(req);

    const result = Object.entries(connectors).map(([id, { name, ...connector }]) => {
      const entry: Record<string, unknown> = { id, connectorName: name || id, ...connector };
      for (const { subPath, urlField } of CONNECTOR_SUBPATHS) {
        const urlConfig = entry[urlField] as ConnectorUrlConfig | undefined;
        if (!urlConfig?.url) {
          delete entry[urlField];
          continue;
        }
        entry[urlField] = urlConfig.proxy
          ? `${serverBase}/api/${id}/${subPath}`
          : urlConfig.url;
      }
      return entry;
    });

    res.json(result);
  });

  return router;
}
