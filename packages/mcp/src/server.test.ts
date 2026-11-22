import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
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

describe('alertSummary — warnings that have not begun are announced, never counted as active', () => {
  const inmetOk = [{ source: 'inmet' as const, state: 'ok' as const }];

  it('does not say "no alert" without mentioning the incoming ones', () => {
    const text = alertSummary(0, inmetOk, 3);
    expect(text).toContain('3 official warning(s)');
    expect(text).toContain('NOT in force yet');
    expect(text).toContain('`upcoming`');
    expect(text).toContain('Absence of an alert is not absence of risk');
  });

  it('keeps the active count apart from the upcoming one', () => {
    const text = alertSummary(1, inmetOk, 2);
    expect(text).toContain('1 active official alert(s)');
    expect(text).toContain('2 official warning(s)');
    expect(text).not.toContain('3 active');
  });

  it('is unchanged when nothing is coming', () => {
    expect(alertSummary(0, inmetOk)).toBe(
      'No active official alert from inmet. Absence of an alert is not absence of risk.',
    );
    expect(alertSummary(0, inmetOk, 0)).not.toContain('LATER');
  });

  it('still refuses an all-clear when a source failed and warnings are incoming', () => {
    const text = alertSummary(0, [{ source: 'nws', state: 'failed', reason: 'x' }], 1);
    expect(text).toContain('NOT an all-clear');
    expect(text).toContain('LATER');
  });
});

describe('nimbai_get_alerts and nimbai_get_summary with an upcoming INMET warning', () => {
  const polygon = JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [-55, -26],
        [-54, -26],
        [-54, -25],
        [-55, -25],
        [-55, -26],
      ],
    ],
  });
  const feed = {
    hoje: [],
    futuro: [
      {
        id: 77,
        descricao: 'Tempestade',
        severidade: 'Perigo',
        inicio: '2026-10-14 06:00',
        fim: '2026-10-14 23:59',
        encerrado: false,
        poligono: polygon,
      },
    ],
  };
  const fakeFetch: typeof globalThis.fetch = async (input) => {
    const u = String(input);
    if (u.includes('apiprevmet3')) {
      return new Response(JSON.stringify(feed), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('nope', { status: 500 });
  };
  type R = {
    isError?: boolean;
    structuredContent?: {
      alerts?: { id: string }[];
      upcoming?: { id: string }[];
      alerts_upcoming?: { id: string }[];
    };
    content?: { text?: string }[];
  };

  it('nimbai_get_alerts: headline says warnings are coming and `upcoming` holds them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const result = (await call('tools/call', {
        name: 'nimbai_get_alerts',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as R;
      expect(result.isError).toBeFalsy();
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
      expect(text).toContain('start LATER');
      expect(text).toContain('NOT in force yet');
      expect(text).not.toMatch(/\d active official alert/);
      expect(result.structuredContent?.alerts).toEqual([]);
      expect(result.structuredContent?.upcoming?.map((a) => a.id)).toEqual(['inmet:77']);
    } finally {
      await close();
      vi.useRealTimers();
    }
  });

  it('nimbai_get_summary: alerts stay empty, alerts_upcoming carries the warning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const result = (await call('tools/call', {
        name: 'nimbai_get_summary',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as R;
      expect(result.isError).toBeFalsy();
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
      expect(text).toContain('start LATER');
      expect(result.structuredContent?.alerts).toEqual([]);
      expect(result.structuredContent?.alerts_upcoming?.map((a) => a.id)).toEqual(['inmet:77']);
    } finally {
      await close();
      vi.useRealTimers();
    }
  });
});

describe('upcoming warnings: summaries when active and upcoming coexist, and severe risk', () => {
  const polygon = JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [-55, -26],
        [-54, -26],
        [-54, -25],
        [-55, -25],
        [-55, -26],
      ],
    ],
  });
  const aviso = (id: number, inicio: string, fim: string) => ({
    id,
    descricao: 'Tempestade',
    severidade: 'Perigo',
    inicio,
    fim,
    encerrado: false,
    poligono: polygon,
  });
  const feed = {
    hoje: [aviso(10, '2026-10-13 00:00', '2026-10-13 23:59')],
    futuro: [aviso(11, '2026-10-14 06:00', '2026-10-14 23:59')],
  };
  const fakeFetch: typeof globalThis.fetch = async (input) =>
    String(input).includes('apiprevmet3')
      ? new Response(JSON.stringify(feed), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('nope', { status: 500 });
  type R = {
    isError?: boolean;
    structuredContent?: { items?: { label: string }[]; upcoming?: { label: string }[] };
    content?: { text?: string }[];
  };
  const textOf = (r: R): string => r.content?.map((c) => c.text ?? '').join('\n') ?? '';

  it('nimbai_get_alerts: leads with the active count and still announces the later one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const r = (await call('tools/call', {
        name: 'nimbai_get_alerts',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as R;
      const text = textOf(r);
      expect(text).toContain('1 active official alert(s)');
      expect(text).toContain('1 official warning(s)');
      expect(text).toContain('start LATER');
      expect(text).not.toContain('2 active');
    } finally {
      await close();
      vi.useRealTimers();
    }
  });

  it('nimbai_get_severe_risk: counts only the one in force and says the other starts LATER', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const r = (await call('tools/call', {
        name: 'nimbai_get_severe_risk',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as R;
      expect(r.isError).toBeFalsy();
      const text = textOf(r);
      expect(text).toContain('1 official warning(s) in force');
      expect(text).toContain('1 more official warning(s)');
      expect(text).toContain('start LATER');
      expect(text).toContain('NOT in force yet');
      expect(text).not.toContain('2 official warning(s) in force');
      expect(r.structuredContent?.items).toHaveLength(1);
      expect(r.structuredContent?.upcoming).toHaveLength(1);
      expect(r.structuredContent?.upcoming?.[0]?.label).toContain('[AINDA NÃO EM VIGOR');
      expect(r.structuredContent?.items?.[0]?.label).not.toContain('AINDA NÃO');
    } finally {
      await close();
      vi.useRealTimers();
    }
  });

  it('nimbai_get_severe_risk: with nothing in force, still announces the later one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    const { call, close } = await session({ fetch: fakeFetch });
    try {
      const r = (await call('tools/call', {
        name: 'nimbai_get_severe_risk',
        arguments: { lat: -25.54, lon: -54.58 },
      })) as R;
      const text = textOf(r);
      expect(text).toContain('No official warning in force');
      expect(text).toContain('start LATER');
    } finally {
      await close();
      vi.useRealTimers();
    }
  });

  it('describes `upcoming` in the nimbai_get_severe_risk tool description', async () => {
    const { call, close } = await session();
    try {
      const listed = (await call('tools/list')) as {
        tools: { name: string; description?: string }[];
      };
      const tool = listed.tools.find((t) => t.name === 'nimbai_get_severe_risk');
      expect(tool?.description).toContain('`upcoming`');
    } finally {
      await close();
    }
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
