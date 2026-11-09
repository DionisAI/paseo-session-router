import { Fault, assert } from './util.js';
export type Schema = {
    type?: string | string[];
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean;
    items?: Schema;
    enum?: unknown[];
    maxLength?: number;
    minLength?: number;
    maximum?: number;
    minimum?: number;
    maxItems?: number;
    description?: string;
};
export const str = (maxLength = 4096): Schema => ({ type: 'string', minLength: 1, maxLength });
export const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: 'integer', minimum, maximum });
export const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export function validate(s: Schema, x: unknown, path = 'arguments'): void { if (s.enum)
    assert(s.enum.some(v => JSON.stringify(v) === JSON.stringify(x)), 'INVALID_ARGUMENT', `${path}: not an allowed value`); const ts = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]; const kind = x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x; assert(!ts.length || ts.includes(kind) || (ts.includes('integer') && typeof x === 'number' && Number.isSafeInteger(x)), 'INVALID_ARGUMENT', `${path}: expected ${ts.join('|')}`); if (typeof x === 'string') {
    assert((s.minLength === undefined || x.length >= s.minLength) && (s.maxLength === undefined || x.length <= s.maxLength), 'INVALID_ARGUMENT', `${path}: invalid string length`);
} if (typeof x === 'number')
    assert(Number.isFinite(x) && (s.minimum === undefined || x >= s.minimum) && (s.maximum === undefined || x <= s.maximum), 'INVALID_ARGUMENT', `${path}: invalid number`); if (Array.isArray(x)) {
    assert(s.maxItems === undefined || x.length <= s.maxItems, 'INVALID_ARGUMENT', `${path}: too many items`);
    if (s.items)
        x.forEach((v, i) => validate(s.items!, v, `${path}[${i}]`));
}
else if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    for (const k of s.required ?? [])
        assert(Object.hasOwn(o, k), 'INVALID_ARGUMENT', `${path}.${k}: required`);
    if (s.additionalProperties === false)
        for (const k of Object.keys(o))
            assert(Object.hasOwn(s.properties ?? {}, k), 'INVALID_ARGUMENT', `${path}.${k}: unknown field`);
    for (const [k, v] of Object.entries(s.properties ?? {}))
        if (Object.hasOwn(o, k))
            validate(v, o[k], `${path}.${k}`);
} }
