import type { HttpClient } from '../http.js';
import { sanitizeExternalText } from '../http.js';
import type { Location } from '../types.js';

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  country?: string;
  admin1?: string;
  timezone?: string;
  population?: number;
}

interface GeoResponse {
  // Absent (not an empty array) when nothing matches.
  results?: GeoResult[];
}

export function locationId(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * Open-Meteo has no reverse-geocoding endpoint, so lat/lon without a query
 * yields one synthetic Location named after the coordinates, with no country.
 * If both are given, the query wins and the coordinates are ignored.
 */
export async function searchLocation(
  http: HttpClient,
  input: { query?: string; lat?: number; lon?: number; limit?: number },
): Promise<Location[]> {
  const query = input.query?.trim();
  if (query) {
    const count = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const params = new URLSearchParams({
      name: query,
      count: String(count),
      language: 'en',
      format: 'json',
    });
    const body = await http.json<GeoResponse>(`${ENDPOINT}?${params.toString()}`);
    return (body.results ?? []).map(toLocation);
  }

  const { lat, lon } = input;
  if (lat === undefined || lon === undefined) {
    throw new Error('searchLocation needs either a query or both lat and lon');
  }
  return [
    {
      id: locationId(lat, lon),
      name: `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`,
      lat,
      lon,
    },
  ];
}

function toLocation(r: GeoResult): Location {
  const loc: Location = {
    id: locationId(r.latitude, r.longitude),
    name: sanitizeExternalText(r.name, 200),
    lat: r.latitude,
    lon: r.longitude,
  };
  if (r.admin1) loc.admin = sanitizeExternalText(r.admin1, 200);
  if (r.country) loc.country = sanitizeExternalText(r.country, 200);
  if (r.country_code?.length === 2) loc.countryCode = r.country_code;
  if (r.timezone) loc.timezone = r.timezone;
  if (r.population !== undefined) loc.population = r.population;
  return loc;
}
