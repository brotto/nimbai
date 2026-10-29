import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { alertSummary, createServer, soundingSummary, type CreateServerOptions } from './server.js';

const EXPECTED_TOOLS = [
  'nimbai_get_alerts',
  'nimbai_get_forecast',
  'nimbai_get_imagery_loop',
  'nimbai_get_lightning',
  'nimbai_get_radar_latest',
  'nimbai_get_satellite_latest',
  'nimbai_get_severe_risk',
  'nimbai_get_sounding',
  'nimbai_get_sources_status',
  'nimbai_get_summary',
  'nimbai_search_location',
];

/**
 * Drives a real MCP session over linked in-memory transports: the handshake
 * and tools/list go through the actual protocol code, not a stub. No network.
 */
async function session(options: CreateServerOptions = {}): Promise<{
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverSide);

  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  clientSide.onmessage = (message: JSONRPCMessage) => {
    const m = message as { id?: number; result?: Record<string, unknown>; error?: unknown };
    if (m.id === undefined) return;
    const resolve = pending.get(m.id);
    if (resolve === undefined) return;
    pending.delete(m.id);
    resolve(m.error !== undefined ? { error: m.error } : (m.result ?? {}));
  };
  await clientSide.start();

  let nextId = 1;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const result = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    await clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    return await result;
  };

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nimbai-test', version: '0' },
  });
  await clientSide.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  } as JSONRPCMessage);

  return { call, close: () => server.close() };
}

describe('NimbAI MCP server', () => {
  it('completes a handshake and advertises exactly the eleven nimbai_ tools', async () => {
    const { call, close } = await session();
    try {
      const listed = (await call('tools/list')) as {
        tools?: { name: string; description?: string; inputSchema?: unknown }[];
      };
      const names = (listed.tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOLS);
    } finally {
      await close();
    }
  });

  it('gives every tool a description, an input schema and read-only annotations', async () => {
    const { call, close } = await session();
    try {
      const listed = (await call('tools/list')) as {
        tools?: {
          name: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
        }[];
      };
      for (const tool of listed.tools ?? []) {
        expect(tool.description, `${tool.name} has no description`).toBeTruthy();
        expect(tool.inputSchema, `${tool.name} has no inputSchema`).toBeTruthy();
        expect(tool.annotations?.readOnlyHint, `${tool.name} is not read-only`).toBe(true);
        expect(tool.annotations?.destructiveHint, `${tool.name} is not non-destructive`).toBe(
          false,
        );
      }
    } finally {
      await close();
    }
  });

  it('fails a point-requiring tool with actionable next steps instead of throwing', async () => {
    const { call, close } = await session();
    try {
      const result = (await call('tools/call', {
        name: 'nimbai_get_severe_risk',
        arguments: {},
      })) as { isError?: boolean; structuredContent?: { next_steps?: string } };
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.next_steps).toContain('nimbai_search_location');
    } finally {
      await close();
    }
  });
});

describe('alertSummary — an empty list must never read as an all-clear', () => {
  it('names the failing source and refuses to call it clear', () => {
    const text = alertSummary(0, [
      { source: 'nws', state: 'failed', reason: 'boom' },
      { source: 'inmet', state: 'outside' },
    ]);
    expect(text).toContain('FAILED');
    expect(text).toContain('NOT an all-clear');
    expect(text).not.toMatch(/^No active official alert/);
  });

  it('says no source covers the place when none was consulted', () => {
    const text = alertSummary(0, [
      { source: 'nws', state: 'outside' },
      { source: 'inmet', state: 'outside' },
    ]);
    expect(text).toContain('No alert source covers this location');
    expect(text).toContain('national weather service');
  });

  it('reports a genuine empty result, still warning that risk may exist', () => {
    const text = alertSummary(0, [
      { source: 'nws', state: 'ok' },
      { source: 'inmet', state: 'outside' },
    ]);
    expect(text).toContain('No active official alert from nws');
    expect(text).toContain('Absence of an alert is not absence of risk');
  });

  it('leads with the count and the verbatim rule when alerts exist', () => {
    const text = alertSummary(2, [{ source: 'nws', state: 'ok' }]);
    expect(text).toContain('2 active official alert(s)');
    expect(text).toContain('verbatim');
  });
});

describe('nimbai_get_alerts with a bbox', () => {
  it('queries the bbox instead of collapsing it to its centre point', async () => {
    const seen: string[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        status: 200,
        headers: { 'content-type': 'application/geo+json' },
      });
    };
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      await call('tools/call', {
        name: 'nimbai_get_alerts',
        arguments: { bbox: [-98, 35, -96, 37] },
      });
      const nws = seen.filter((u) => u.includes('api.weather.gov'));
      expect(nws.length).toBeGreaterThan(0);
      for (const url of nws) {
        expect(new URL(url).searchParams.has('point'), `${url} collapsed the bbox`).toBe(false);
      }
    } finally {
      await close();
    }
  });
});

describe('nimbai_get_sounding', () => {
  const fixture = readFileSync(
    new URL('../../core/src/adapters/__fixtures__/open-meteo-sounding-foz.json', import.meta.url),
    'utf8',
  );
  const fakeFetch: typeof globalThis.fetch = async () =>
    new Response(fixture, { status: 200, headers: { 'content-type': 'application/json' } });

  it('leads with the parcel it used and puts the model’s own CAPE next to it', async () => {
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const result = (await call('tools/call', {
        name: 'nimbai_get_sounding',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as {
        isError?: boolean;
        structuredContent?: { sounding?: { kinematics?: { cyclonicMover?: string } } };
        content?: { text?: string }[];
      };
      expect(result.isError).toBeFalsy();
      const text = result.content?.[0]?.text ?? '';
      expect(text).toContain('Surface parcel');
      expect(text).toContain("The model's own CAPE");
      expect(text).toContain('No radiosonde was launched here');
      // Brazil: the cyclonic member is the left mover, and the summary says so.
      expect(text).toContain('LEFT (cyclonic here)');
      // The quoted SRH is the flipped one, so the sentence has to admit it
      // and carry the raw integral — the reader cannot otherwise tell which
      // convention the number is in.
      expect(text).toContain('sign-flipped for the Southern Hemisphere');
      expect(text).toContain('raw integral');
      // CIN is negative here and positive in `model`: say which is which.
      expect(text).toContain('negative by convention');
      expect(result.structuredContent?.sounding?.kinematics?.cyclonicMover).toBe('left');
    } finally {
      await close();
    }
  });

  it('carries the safety notice and the Open-Meteo attribution', async () => {
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const result = (await call('tools/call', {
        name: 'nimbai_get_sounding',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as { content?: { text?: string }[] };
      const text = result.content?.[0]?.text ?? '';
      expect(text).toContain('Weather data by Open-Meteo.com');
      expect(text).toContain('Not for protection of life or property');
    } finally {
      await close();
    }
  });
});

describe('soundingSummary', () => {
  const base = {
    validTime: '2026-10-29T18:00:00Z',
    thermodynamics: { surfaceParcel: null, mixedLayerParcel: null },
    kinematics: {
      hemisphere: 'northern',
      cyclonicMover: 'right',
      bulkShear0to6kmMs: null,
      srh0to3kmM2S2: null,
      srh0to3kmRawM2S2: null,
    },
    model: { capeJkg: null },
  };

  it('does not claim a sign flip in the Northern Hemisphere', () => {
    const north = {
      ...base,
      kinematics: { ...base.kinematics, hemisphere: 'northern', srh0to3kmRawM2S2: 120 },
    };
    const text = soundingSummary(north as unknown as Parameters<typeof soundingSummary>[0]);
    expect(text).not.toContain('sign-flipped');
  });

  it('says n/a rather than printing a missing number as zero', () => {
    const text = soundingSummary(base as unknown as Parameters<typeof soundingSummary>[0]);
    expect(text).toContain('No parcel could be lifted');
    expect(text).toContain('n/a');
    expect(text).not.toContain('0 J/kg');
  });
});
