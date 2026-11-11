import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../x-twitter-carousel-expand.user.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const marker = '    // ==========================================================\n    // 初始化执行';
assert.ok(source.includes(marker), 'Initialization marker missing');
const testSource = source.slice(0, source.indexOf(marker)) +
    'globalThis.api = { combineImages, getStoredSettings, saveStoredSettings, copyToClipboard, yieldToMain };})();';

function harness({ failAt = -1, encodeFailure = false, deniedStorage = false, scheduler } = {}) {
    const state = { closed: [], draws: [], canvas: null, requests: 0 };
    const values = new Map();
    const context = {
        console, Blob, setTimeout, clearTimeout, performance: { now: () => 100 },
        Map, Set, URL, scheduler,
        MutationObserver: class { observe() {} },
        document: {
            body: {},
            createElement(tag) {
                assert.equal(tag, 'canvas');
                state.canvas = {
                    width: 0, height: 0,
                    getContext: () => ({ fillRect() {}, drawImage: (...args) => state.draws.push(args.slice(1)) }),
                    toBlob(callback, type) { callback(encodeFailure ? null : new Blob(['encoded'], { type })); }
                };
                return state.canvas;
            }
        },
        GM_xmlhttpRequest(options) {
            const index = state.requests++;
            if (index === failAt) options.onerror();
            else options.onload({ status: 200, response: new Blob([options.url]) });
        },
        async createImageBitmap() {
            const id = state.requests;
            return { width: 3, height: 4, close() { state.closed.push(id); } };
        }
    };
    Object.defineProperty(context, 'localStorage', { get() {
        if (deniedStorage) throw new Error('Storage denied');
        return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    } });
    vm.createContext(context);
    vm.runInContext(testSource, context);
    return { api: context.api, context, state, values };
}

const options = { format: 'image/png', quality: 0.85, scaleMode: '0.5' };

test('scaled tiles meet at rounded cumulative boundaries and resources are released', async () => {
    const { api, state } = harness();
    const output = await api.combineImages(['a', 'b', 'c'], options);
    assert.equal(output.width, 5);
    assert.equal(output.height, 2);
    assert.deepEqual(state.draws.map(([x, , width]) => [x, width]), [[0, 2], [2, 1], [3, 2]]);
    assert.equal(state.closed.length, 3);
    assert.equal(state.canvas.width, 1);
    assert.equal(state.canvas.height, 1);
});

test('a later failed image download releases earlier decoded bitmaps', async () => {
    const { api, state } = harness({ failAt: 1 });
    await assert.rejects(api.combineImages(['a', 'b'], options), /网络错误/);
    assert.equal(state.closed.length, 1);
});

test('failed encoding releases every bitmap and resets canvas memory', async () => {
    const { api, state } = harness({ encodeFailure: true });
    await assert.rejects(api.combineImages(['a', 'b'], options), /图片编码失败/);
    assert.equal(state.closed.length, 2);
    assert.equal(state.canvas.width, 1);
    assert.equal(state.canvas.height, 1);
});

test('invalid stored values fall back to valid export settings', () => {
    const { api, values } = harness();
    values.set('__x_carousel_format_v6__', '<invalid>');
    values.set('__x_carousel_quality_v6__', 'NaN');
    values.set('__x_carousel_scale_v6__', 'javascript:invalid');
    const settings = api.getStoredSettings();
    assert.equal(settings.format, 'image/jpeg');
    assert.equal(settings.quality, 0.85);
    assert.equal(settings.scaleMode, '1');
});

test('export settings remain usable when browser storage is denied', () => {
    const { api } = harness({ deniedStorage: true });
    api.saveStoredSettings({ format: 'image/webp', quality: 0.6, scaleMode: '0.75' });
    const settings = api.getStoredSettings();
    assert.equal(settings.format, 'image/webp');
    assert.equal(settings.quality, 0.6);
    assert.equal(settings.scaleMode, '0.75');
});

test('yield uses native scheduler when present and timer fallback otherwise', async () => {
    let nativeCalls = 0;
    const native = harness({ scheduler: { yield: async () => { nativeCalls++; } } });
    await native.api.yieldToMain();
    assert.equal(nativeCalls, 1);
    await harness().api.yieldToMain();
});

test('PNG clipboard fallback reports the actual written byte size', async () => {
    const { api, context } = harness();
    let writes = 0;
    context.navigator = { clipboard: { async write() { writes++; } } };
    context.ClipboardItem = class { static supports(type) { return type === 'image/png'; } constructor(data) { this.data = data; } };
    const requested = new Blob(['x'], { type: 'image/jpeg' });
    const fallback = new Blob(['larger png bytes'], { type: 'image/png' });
    const result = await api.copyToClipboard(requested, 'image/jpeg', async () => fallback);
    assert.equal(result.isFallback, true);
    assert.equal(result.size, fallback.size);
    assert.equal(writes, 1);
});
