import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { weatherSource, skyKind, parseForecast, checkWeatherPlace, type WeatherPlace } from '../src/weather.js';
import { demoConfig, validateConfig } from '../src/config.js';
import { startHttp } from '../src/server.js';
import { fixture, code } from './helpers.js';
const sample = { utc_offset_seconds: 32400, current: { time: '2026-10-27T00:45', temperature_2m: 14.2, weather_code: 61, cloud_cover: 96, precipitation: 0.6, wind_speed_10m: 12.4, wind_direction_10m: 40, is_day: 0 }, daily: { sunrise: ['2026-10-27T05:59'], sunset: ['2026-10-27T16:45'] } };
const TOKYO: WeatherPlace = { name: '東京', timezone: 'Asia/Tokyo', latitude: 35.6895, longitude: 139.6917 };
const never = (async () => { throw new Error('no request may be made'); }) as unknown as typeof globalThis.fetch;
test('weather: WMO codes map to the skies the park draws; the forecast keeps local clock times', () => {
    assert.deepEqual([0, 2, 3, 45, 53, 63, 81, 73, 86, 95, 99].map(skyKind), ['clear', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'snow', 'storm', 'storm']);
    assert.deepEqual(parseForecast(sample), { kind: 'rain', code: 61, temperature: 14.2, precipitation: 0.6, cloudCover: 96, windSpeed: 12.4, windDirection: 40, isDay: false, localTime: '00:45', sunrise: '05:59', sunset: '16:45' });
    assert.throws(() => parseForecast({}));
});
test('weather: the configured place, one fetch per cache period however many viewers ask; a failure keeps the last good sky for a while', async () => {
    let clock = 0, calls = 0, fail = false;
    const fetch = (async (url: string) => { calls++; assert.match(url, /latitude=35\.6895.*timezone=Asia%2FTokyo/); if (fail) throw new Error('offline'); return new Response(JSON.stringify(sample)); }) as typeof globalThis.fetch;
    const sky = weatherSource({ place: TOKYO, fetch, now: () => clock, ttlMs: 600000, retryMs: 120000 });
    const [a, b] = await Promise.all([sky(), sky()]);
    assert.equal(calls, 1); assert.equal(a.current?.kind, 'rain'); assert.equal(b.place, '東京'); assert.equal(a.timezone, 'Asia/Tokyo'); assert.equal(a.hemisphere, 'north');
    clock = 300000; await sky(); assert.equal(calls, 1);
    fail = true; clock = 700000; assert.equal((await sky()).current?.kind, 'rain'); assert.equal(calls, 2);
    clock = 760000; await sky(); assert.equal(calls, 2); // waits before trying again
    clock = 4 * 3600000; const stale = await sky(); assert.equal(stale.current, null); assert.equal(stale.fetchedAt, null);
});
test('weather: without a place nothing is fetched; a place without coordinates gives only its clock; seasons turn south of the equator', async () => {
    assert.deepEqual(await weatherSource({ fetch: never })(), { place: null, timezone: null, hemisphere: 'north', current: null, fetchedAt: null });
    assert.deepEqual(await weatherSource({ place: { name: 'Berlin', timezone: 'Europe/Berlin' }, fetch: never })(), { place: 'Berlin', timezone: 'Europe/Berlin', hemisphere: 'north', current: null, fetchedAt: null });
    const fetch = (async () => new Response(JSON.stringify(sample))) as unknown as typeof globalThis.fetch;
    assert.equal((await weatherSource({ place: { name: 'Sydney', timezone: 'Australia/Sydney', latitude: -33.87, longitude: 151.21 }, fetch })()).hemisphere, 'south');
});
test('weather: the config names a place with a real time zone, and coordinates both or neither', () => {
    assert.equal(checkWeatherPlace(undefined), null);
    assert.equal(checkWeatherPlace(TOKYO), null);
    assert.equal(checkWeatherPlace({ name: 'Berlin', timezone: 'Europe/Berlin' }), null);
    for (const bad of [null, 'Tokyo', [], { timezone: 'Asia/Tokyo' }, { name: '', timezone: 'Asia/Tokyo' }, { name: 'x'.repeat(41), timezone: 'Asia/Tokyo' }, { name: 'Nowhere', timezone: 'Mars/Olympus' },
        { name: 'Half', timezone: 'Asia/Tokyo', latitude: 35 }, { name: 'Far', timezone: 'Asia/Tokyo', latitude: 91, longitude: 0 }, { name: 'Text', timezone: 'Asia/Tokyo', latitude: '35', longitude: '139' }])
        assert.ok(checkWeatherPlace(bad), JSON.stringify(bad));
    const c = demoConfig('/tmp/not-used'); (c as { weather?: unknown }).weather = { name: 'Nowhere', timezone: 'Mars/Olympus' };
    assert.throws(() => validateConfig(c), code('CONFIG'));
    c.weather = TOKYO; validateConfig(c);
});
test('weather: the console reads it with its own credential; by default the Router serves the configured place, and none means no request', async () => {
    const f = await fixture(), tokens = new Map(f.config.clients.map(c => [c.clientId, randomBytes(32).toString('hex')]));
    for (const c of f.config.clients) process.env[c.tokenEnv] = tokens.get(c.clientId); const token = tokens.get('web')!;
    const report = { place: '東京', timezone: 'Asia/Tokyo', hemisphere: 'north' as const, current: null, fetchedAt: null };
    const http = await startHttp(f.router, { port: 0, weather: async () => report });
    try {
        assert.equal((await fetch(http.baseUrl + '/v1/weather')).status, 401);
        const r = await fetch(http.baseUrl + '/v1/weather', { headers: { authorization: `Bearer ${token}` } });
        assert.equal(r.status, 200); assert.deepEqual(await r.json(), report);
    }
    finally { await http.close(); }
    // no weather in the config (as in the demo): the Router answers without going anywhere
    assert.equal(f.config.weather, undefined);
    const plain = await startHttp(f.router, { port: 0 });
    try { assert.deepEqual(await (await fetch(plain.baseUrl + '/v1/weather', { headers: { authorization: `Bearer ${token}` } })).json(), { place: null, timezone: null, hemisphere: 'north', current: null, fetchedAt: null }); }
    finally { await plain.close(); await f.close(); }
});
