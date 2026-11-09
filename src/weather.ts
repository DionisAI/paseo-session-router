// The sky over the console's park: the clock, season and current weather of one place the owner chooses (config `weather`),
// the weather from Open-Meteo. The Router fetches it at most once per cache period, so every viewer sees the same sky and no
// browser needs to reach outside the tailnet. Without coordinates nothing is fetched; without `weather` at all, the console
// keeps the viewer's own clock and shows no weather.
// Presentation only: nothing here touches routing, and a failed fetch just leaves the sky without weather.
export type SkyKind = 'clear' | 'cloudy' | 'overcast' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
export interface WeatherNow {
    kind: SkyKind;
    /** WMO weather interpretation code as Open-Meteo reports it. */
    code: number;
    temperature: number | null;
    /** mm in the last hour */
    precipitation: number;
    cloudCover: number;
    /** km/h; the direction the wind comes from, in degrees */
    windSpeed: number;
    windDirection: number;
    isDay: boolean;
    /** the place's local time of the observation, and today's sunrise and sunset there, as HH:MM */
    localTime: string;
    sunrise: string | null;
    sunset: string | null;
}
export interface WeatherReport {
    /** null: no place configured (the console uses the viewer's own clock) */
    place: string | null;
    timezone: string | null;
    /** where seasons come from: south of the equator they run six months apart */
    hemisphere: 'north' | 'south';
    current: WeatherNow | null;
    fetchedAt: number | null;
}
/** The console's place: a name to show, its IANA time zone, and (for weather) its coordinates. */
export interface WeatherPlace { name: string; timezone: string; latitude?: number; longitude?: number }
/** The config's `weather`, checked: a name of 1–40 characters, a time zone this Node knows, coordinates both or neither. */
export function checkWeatherPlace(w: unknown): string | null {
    if (w === undefined) return null;
    const x = w as Partial<WeatherPlace>;
    if (!w || typeof w !== 'object' || Array.isArray(w)) return 'weather must be an object: {name, timezone, latitude?, longitude?}';
    if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 40) return 'weather.name: the place to show, 1–40 characters';
    try { if (typeof x.timezone !== 'string') throw new Error(); new Intl.DateTimeFormat('en-US', { timeZone: x.timezone }); }
    catch { return 'weather.timezone: an IANA time zone such as Europe/Berlin'; }
    const lat = x.latitude, lon = x.longitude, real = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
    if ((lat === undefined) !== (lon === undefined)) return 'weather: give latitude and longitude together, or neither (then no weather is fetched)';
    if (lat !== undefined && !(real(lat, 90) && real(lon, 180))) return 'weather.latitude: -90..90, weather.longitude: -180..180';
    return null;
}
/** WMO codes → the few skies the park can draw. */
export function skyKind(code: number): SkyKind {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2) return 'cloudy';
    if (code === 3) return 'overcast';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloudy';
}
const clock = (iso: unknown) => typeof iso === 'string' && /T\d\d:\d\d/.test(iso) ? iso.slice(iso.indexOf('T') + 1, iso.indexOf('T') + 6) : null;
const num = (v: unknown, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
export function parseForecast(body: any): WeatherNow {
    const c = body?.current;
    if (!c || typeof c.weather_code !== 'number') throw new Error('Open-Meteo response has no current weather');
    return {
        kind: skyKind(c.weather_code), code: c.weather_code, temperature: typeof c.temperature_2m === 'number' ? c.temperature_2m : null,
        precipitation: num(c.precipitation), cloudCover: num(c.cloud_cover), windSpeed: num(c.wind_speed_10m), windDirection: num(c.wind_direction_10m), isDay: c.is_day !== 0,
        localTime: clock(c.time) ?? '', sunrise: clock(body.daily?.sunrise?.[0]), sunset: clock(body.daily?.sunset?.[0]),
    };
}
export type WeatherSource = () => Promise<WeatherReport>;
/** One fetch per `ttlMs` at most, however many viewers ask; after a failure, the last good report for up to three hours. */
/** No place: the console keeps the viewer's clock. A place without coordinates: its clock and seasons, nothing fetched. */
export function weatherSource(options: { place?: WeatherPlace | null; fetch?: typeof fetch; now?: () => number; ttlMs?: number; retryMs?: number } = {}): WeatherSource {
    const place = options.place ?? null, hemisphere = (place?.latitude ?? 0) < 0 ? 'south' as const : 'north' as const;
    if (!place || place.latitude === undefined || place.longitude === undefined) {
        const report: WeatherReport = { place: place?.name ?? null, timezone: place?.timezone ?? null, hemisphere, current: null, fetchedAt: null };
        return async () => report;
    }
    const get = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now, ttl = options.ttlMs ?? 10 * 60000, retry = options.retryMs ?? 2 * 60000;
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: String(place.latitude), longitude: String(place.longitude), timezone: place.timezone, forecast_days: '1',
        current: 'temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,is_day', daily: 'sunrise,sunset',
    });
    let last: { current: WeatherNow; at: number } | null = null, nextTry = 0, pending: Promise<void> | null = null;
    async function refresh() {
        try {
            const res = await get(url, { signal: AbortSignal.timeout(6000) });
            if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
            last = { current: parseForecast(await res.json()), at: now() };
            nextTry = now() + ttl;
        }
        catch { nextTry = now() + retry; }
    }
    return async () => {
        if (now() >= nextTry) await (pending ??= refresh().finally(() => { pending = null; }));
        const fresh = last && now() - last.at < 3 * 3600000 ? last : null;
        return { place: place.name, timezone: place.timezone, hemisphere, current: fresh?.current ?? null, fetchedAt: fresh?.at ?? null };
    };
}
