/**
 * YAML pipeline executor for public-API platforms.
 * Loads a YAML adapter, substitutes variables, fetches data,
 * maps fields, and returns structured items.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Adapters live at <repo-root>/adapters/
const ADAPTERS_ROOT = path.resolve(__dirname, '../../adapters');

export interface PipelineConfig {
  url: string;
  source?: string;      // JSON path into response (e.g. "hits")
  responseRoot?: string; // Alias for source; "" means root-level array
  paginate?: {
    type: 'ids' | 'offset' | 'cursor';
    limit?: string;
    pageSize?: string;
    itemUrl?: string; // For ids pagination: URL template to fetch each item
  };
  filter?: Record<string, string>; // field -> expected value
  map: Record<string, string>; // outputKey -> sourceField
  template: string;
  sort?: string; // "field desc" or "field asc"
}

/** Substitute {{var}} placeholders in a string. */
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : '';
  });
}

/** Navigate a dot-path into an object. */
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/** Map a raw API item to output schema. */
function mapItem(raw: Record<string, unknown>, mapping: Record<string, string>, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = { _index: index + 1 };
  for (const [outKey, srcKey] of Object.entries(mapping)) {
    if (srcKey === '_index') {
      out[outKey] = index + 1;
    } else {
      const val = getPath(raw, srcKey);
      out[outKey] = val !== undefined && val !== null ? val : '';
    }
  }
  return out;
}

/** Load and parse a YAML adapter file. */
async function loadAdapter(platform: string, command: string): Promise<PipelineConfig> {
  const file = path.join(ADAPTERS_ROOT, platform, `${command}.yaml`);
  const raw = await fs.readFile(file, 'utf8');
  // Minimal YAML parser for our simple format (no deps)
  return parseSimpleYaml(raw);
}

/** Very minimal YAML parser sufficient for our adapter format. */
function parseSimpleYaml(yaml: string): PipelineConfig {
  const lines = yaml.split('\n');
  const config: Record<string, unknown> = {};
  let currentSection: string | null = null;
  let currentSubsection: string | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('#') || !line.trim()) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    if (indent === 0) {
      currentSection = null;
      currentSubsection = null;
      const m = line.match(/^(\w+):\s*(.*)/);
      if (!m) continue;
      const [, key, val] = m;
      if (val.trim()) {
        config[key] = val.replace(/^["']|["']$/g, '');
      } else {
        config[key] = {};
        currentSection = key;
      }
    } else if (indent === 2 && currentSection) {
      currentSubsection = null;
      const m = line.match(/^\s{2}(\w+):\s*(.*)/);
      if (!m) continue;
      const [, key, val] = m;
      const section = config[currentSection] as Record<string, unknown>;
      if (val.trim()) {
        section[key] = val.replace(/^["']|["']$/g, '');
      } else {
        section[key] = {};
        currentSubsection = key;
      }
    } else if (indent === 4 && currentSection && currentSubsection) {
      const m = line.match(/^\s{4}(\w+):\s*(.*)/);
      if (!m) continue;
      const [, key, val] = m;
      const section = config[currentSection] as Record<string, unknown>;
      const sub = section[currentSubsection] as Record<string, unknown>;
      sub[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return config as unknown as PipelineConfig;
}

export interface PipelineVars {
  limit?: number;
  query?: string;
  [key: string]: unknown;
}

export interface PipelineResult {
  items: Array<Record<string, unknown>>;
  template: string | undefined;
}

/**
 * Execute a YAML pipeline adapter and return mapped items plus the YAML template.
 */
export async function executePipeline(
  platform: string,
  command: string,
  vars: PipelineVars = {}
): Promise<PipelineResult> {
  const config = await loadAdapter(platform, command);
  const limit = vars.limit ?? 20;
  const allVars = { limit, ...vars };

  const url = interpolate(config.url, allVars);

  if (config.paginate?.type === 'ids') {
    // Fetch ID list, then each item individually.
    // Fetch extra IDs to account for items that may be filtered out.
    const ids = await request<number[]>(url);
    const fetchCount = config.filter ? Math.min(ids.length, limit * 3) : limit;
    const sliced = ids.slice(0, fetchCount);
    const itemUrlTemplate = config.paginate.itemUrl ?? '';
    const rawItems = await Promise.all(
      sliced.map((id) =>
        request<Record<string, unknown>>(interpolate(itemUrlTemplate, { ...allVars, id }))
          .catch(() => null)
      )
    );

    // Apply filter on raw API items (before mapping)
    let filtered = rawItems.filter((x): x is Record<string, unknown> => x !== null);
    if (config.filter) {
      for (const [key, val] of Object.entries(config.filter)) {
        filtered = filtered.filter((item) => String(item[key]) === String(val));
      }
    }

    return {
      items: filtered.slice(0, limit).map((item, i) => mapItem(item, config.map, i)),
      template: config.template,
    };
  }

  // Simple fetch
  const raw = await request<unknown>(url);
  let data: unknown[] = [];

  // responseRoot="" means root-level array; responseRoot="items" means nested
  const rootPath = config.source ?? config.responseRoot;
  if (rootPath !== undefined && rootPath !== '') {
    data = (getPath(raw, rootPath) as unknown[]) ?? [];
  } else if (Array.isArray(raw)) {
    data = raw;
  } else {
    data = [raw as Record<string, unknown>];
  }

  let items = (data as Record<string, unknown>[]).slice(0, limit).map((item, i) =>
    mapItem(item, config.map, i)
  );

  if (config.filter) {
    for (const [key, val] of Object.entries(config.filter)) {
      items = items.filter((item) => String(item[key]) === String(val));
    }
  }

  if (config.sort) {
    const [sortField, sortDir] = config.sort.split(' ');
    items.sort((a, b) => {
      const av = Number(a[sortField]) || 0;
      const bv = Number(b[sortField]) || 0;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }

  return { items: items.slice(0, limit), template: config.template };
}

export { loadAdapter };
