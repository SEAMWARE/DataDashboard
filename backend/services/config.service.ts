import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { join } from 'path';

const CONFIG_DIR = join(process.cwd(), 'config');

export interface ConnectorUrlConfig {
  url: string;
  proxy: boolean;
}

export interface ConnectorConfig {
  name: string;
  managementUrl: ConnectorUrlConfig;
  defaultUrl: ConnectorUrlConfig;
  protocolUrl: ConnectorUrlConfig;
  federatedCatalogEnable: boolean;
  federatedCatalogUrl: ConnectorUrlConfig;
  did: string;
}

interface CorsConfig {
  origin: string;
  methods: string[];
  allowedHeaders: string[];
  credentials: boolean;
  optionsSuccessStatus: number;
  maxAge: number;
}

interface ServerConfig {
  port: number;
  staticPath: string;
  trustProxy: number;
  jsonBodyLimit: string;
  publicUrl?: string;
  proxyTimeout: number;
  storage: { destFolder: string; maxSizeMB: number };
  cors: CorsConfig;
}

export interface AppConfig {
  server: ServerConfig;
  logging: { level: string };
  connectors: Record<string, ConnectorConfig>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] == null) continue;
    if (
      typeof override[key] === 'object' && !Array.isArray(override[key]) &&
      base[key] != null && typeof base[key] === 'object' && !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function loadConfig(): AppConfig {
  const defaultConfig = load(readFileSync(join(CONFIG_DIR, 'application.default.yaml'), 'utf8')) as AppConfig;
  const localPath = join(CONFIG_DIR, 'application.yaml');
  if (!existsSync(localPath)) return defaultConfig;
  const localConfig = load(readFileSync(localPath, 'utf8')) as Partial<AppConfig> | null;
  return localConfig ? (deepMerge(defaultConfig, localConfig) as AppConfig) : defaultConfig;
}

const config = loadConfig();

export const configService = {
  get: (): AppConfig => config,
};
