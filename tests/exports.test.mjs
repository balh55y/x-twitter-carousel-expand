import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../x-twitter-carousel-expand.user.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const marker = '    // ==========================================================\n    // 初始化执行';
assert.ok(source.includes(marker), 'Initialization marker missing');
const testSource = source.slice(0, source.indexOf(marker)) +
    'globalThis.api = { combineImages, planImageLayout, scaleImageLayout, getExportSizeError, selectedImageUrls, getStoredSettings, saveStoredSettings, copyToClipboard, yieldToMain };})();';

function harness({ failAt = -1, encodeFailure = false, deniedStorage = false, scheduler, dimensions = {}, drawFailure = false, encodedDimensions, encodedDecodeFailure = false } = {}) {
    const state = { closed: [], draws: [], canvas: null, requests: 0, urls: [], decoded: 0, active: 0, maxActive: 0 };
    const values = new Map();
    const encodedSizes = new WeakMap();
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
                    getContext: () => ({ fillRect() {}, drawImage: (...args) => { if (drawFailure) throw new Error('draw failed'); state.draws.push(args.slice(1)); } }),
                    toBlob(callback, type) {
                        if (encodeFailure) { callback(null); return; }
                        const blob = new Blob(['encoded'], { type });
                        encodedSizes.set(blob, encodedDimensions || { width: this.width, height: this.height });
                        callback(blob);
                    }
                };
                return state.canvas;
            }
        },
        GM_xmlhttpRequest(options) {
            state.urls.push(options.url);
            const index = state.requests++;
            if (index === failAt) options.onerror();
            else options.onload({ status: 200, response: new Blob([options.url]) });
        },
        async createImageBitmap(blob) {
            const id = ++state.decoded;
            if (encodedSizes.has(blob)) {
                assert.equal(state.canvas.width, 1, 'release canvas before validating encoded file');
                assert.equal(state.canvas.height, 1);
                if (encodedDecodeFailure) throw new Error('decode failed');
            }
            const size = encodedSizes.get(blob) || dimensions[await blob.text()] || { width: 3, height: 4 };
            state.active++;
            state.maxActive = Math.max(state.maxActive, state.active);
            return { ...size, close() { state.closed.push(id); state.active--; } };
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
    assert.equal(state.closed.length, 7);
    assert.equal(state.active, 0);
    assert.equal(state.maxActive, 1);
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
    assert.equal(state.closed.length, 4);
    assert.equal(state.active, 0);
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

test('nonconsecutive selection retains post order and downloads only selected URLs', async () => {
    const { api, state } = harness();
    const images = Array.from({ length: 20 }, (_, index) => 'image-' + index);
    const urls = api.selectedImageUrls(images, new Set([18, 1, 7]));
    assert.deepEqual(Array.from(urls), ['image-1', 'image-7', 'image-18']);
    await api.combineImages(urls, { ...options, layout: 'grid-2' });
    assert.deepEqual(state.urls, ['image-1', 'image-7', 'image-18']);
});

test('empty selection cannot create a blank export or start network requests', async () => {
    const { api, state } = harness();
    await assert.rejects(api.combineImages([], options), /至少选择/);
    assert.equal(state.requests, 0);
    assert.equal(state.canvas, null);
});

test('vertical layout sums heights and keeps each image aspect ratio', async () => {
    const { api, state } = harness({ dimensions: { a: { width: 4, height: 3 }, b: { width: 2, height: 5 } } });
    const output = await api.combineImages(['a', 'b'], { ...options, scaleMode: '1', layout: 'vertical' });
    assert.deepEqual([output.width, output.height], [4, 8]);
    assert.deepEqual(state.draws, [[0, 0, 4, 3], [0, 3, 2, 5]]);
});

test('two-column grid leaves an incomplete last row without cropping', () => {
    const { api } = harness();
    const plan = api.planImageLayout([{width:4,height:3},{width:2,height:5},{width:3,height:2}], 'grid-2');
    assert.deepEqual([plan.width, plan.height], [8, 7]);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.placements)), [
        {x:0,y:0,width:4,height:3},{x:5,y:0,width:2,height:5},{x:0.5,y:5,width:3,height:2}
    ]);
});

test('20 photos use seven rows in a three-column grid and preserve order', async () => {
    const { api, state } = harness();
    const result = await api.combineImages(Array.from({length:20},(_,i)=>String(i)), {...options,scaleMode:'1',layout:'grid-3'});
    assert.deepEqual([result.width,result.height],[9,28]);
    assert.equal(state.draws.length,20);
    assert.deepEqual(state.draws[19],[3,24,3,4]);
    assert.equal(state.closed.length,41);
    assert.equal(state.active,0);
    assert.equal(state.maxActive,1);
});

test('single selection yields the same dimensions in all layouts', () => {
    const { api } = harness();
    for (const layout of ['horizontal','vertical','grid-2','grid-3']) {
        const plan = api.planImageLayout([{width:800,height:600}],layout);
        assert.deepEqual([plan.width,plan.height],[800,600]);
    }
});

test('height cap applies to the composed output, not individual rows', () => {
    const { api } = harness();
    const plan = api.planImageLayout([{width:800,height:1200},{width:800,height:1200}], 'vertical');
    const result = api.scaleImageLayout(plan,'max-1080');
    assert.deepEqual([result.width,result.height],[360,1080]);
});

test('oversized canvas is rejected before allocation and decoded images are released', async () => {
    const { api, state } = harness({dimensions:{a:{width:9000,height:9000}}});
    await assert.rejects(api.combineImages(['a'], {...options,scaleMode:'1'}), /减少选择或降低尺寸/);
    assert.equal(state.canvas,null);
    assert.equal(state.closed.length,1);
});

test('layout and 25 percent scale persist; invalid layout falls back', () => {
    const { api, values } = harness();
    values.set('__x_carousel_layout_v6__','invalid');
    assert.equal(api.getStoredSettings().layout,'horizontal');
    api.saveStoredSettings({layout:'grid-3',scaleMode:'0.25'});
    assert.equal(api.getStoredSettings().layout,'grid-3');
    assert.equal(api.getStoredSettings().scaleMode,'0.25');
});


test('draw failure releases the currently decoded image and canvas', async () => {
    const { api, state } = harness({ drawFailure: true });
    await assert.rejects(api.combineImages(['a', 'b'], options), /draw failed/);
    assert.equal(state.active, 0);
    assert.equal(state.closed.length, state.decoded);
    assert.equal(state.canvas.width, 1);
});


for (const axis of ['width', 'height']) {
    test('WebP rejects oversized ' + axis + ' before canvas allocation', async () => {
        const size = { width: 20, height: 20, [axis]: 16384 };
        const { api, state } = harness({ dimensions: { a: size } });
        await assert.rejects(api.combineImages(['a'], { ...options, format: 'image/webp', scaleMode: '1' }), /16383 px.*JPEG[\/]PNG/);
        assert.equal(state.canvas, null);
        assert.equal(state.closed.length, 1);
        assert.equal(state.active, 0);
    });

    test('WebP accepts the exact ' + axis + ' limit', async () => {
        const size = { width: 20, height: 20, [axis]: 16383 };
        const { api, state } = harness({ dimensions: { a: size } });
        const result = await api.combineImages(['a'], { ...options, format: 'image/webp', scaleMode: '1' });
        assert.equal(result[axis], 16383);
        assert.equal(state.active, 0);
    });
}

test('WebP size validation uses the selected scale', async () => {
    const { api, state } = harness({ dimensions: { a: { width: 3072, height: 19965 } } });
    const result = await api.combineImages(['a'], { ...options, format: 'image/webp', scaleMode: '0.75' });
    assert.deepEqual([result.width, result.height], [2304, 14974]);
    assert.equal(state.active, 0);
});

test('JPEG and PNG keep full height above the WebP limit', async () => {
    for (const format of ['image/jpeg', 'image/png']) {
        const { api, state } = harness({ dimensions: { a: { width: 3072, height: 19965 } } });
        const result = await api.combineImages(['a'], { ...options, format, scaleMode: '1' });
        assert.deepEqual([result.width, result.height], [3072, 19965]);
        assert.equal(state.active, 0);
    }
});

test('preview and export share WebP limits and canvas area checks', () => {
    const { api } = harness();
    assert.match(api.getExportSizeError({width:3072,height:19965}, 'image/webp'), /16383 px/);
    assert.equal(api.getExportSizeError({width:3072,height:19965}, 'image/jpeg'), '');
    assert.match(api.getExportSizeError({width:9000,height:9000}, 'image/webp'), /减少选择或降低尺寸/);
});

for (const encodedDimensions of [{width:4,height:4},{width:6,height:3}]) {
    test('cropped encoded file ' + JSON.stringify(encodedDimensions) + ' cannot report success', async () => {
        const { api, state } = harness({ encodedDimensions });
        await assert.rejects(api.combineImages(['a','b'], {...options,scaleMode:'1'}), /导出图片尺寸不完整/);
        assert.equal(state.closed.length, 5);
        assert.equal(state.active, 0);
        assert.equal(state.canvas.width, 1);
        assert.equal(state.canvas.height, 1);
    });
}

test('unreadable encoded output is rejected and canvas memory is released', async () => {
    const { api, state } = harness({ encodedDecodeFailure: true });
    await assert.rejects(api.combineImages(['a'], options), /无法检查导出图片/);
    assert.equal(state.closed.length, 2);
    assert.equal(state.active, 0);
    assert.equal(state.canvas.width, 1);
});
