import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../x-twitter-carousel-expand.user.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const marker = '    // ==========================================================\n    // 初始化执行';
assert.ok(source.includes(marker), 'Initialization marker missing');
const testSource = source.slice(0, source.indexOf(marker)) +
    'globalThis.api = { findActionRow,getImages,normalizeImageUrl,safeMediaUrl,mediaFromTweetData,readTweetMedia,collectDomMedia,getPostMedia,getPostIdentity,mediaFilename,buildMediaZip,prepareMediaDownload,fetchTweetMedia,createImageCache,combineImages, planImageLayout, scaleImageLayout, getExportSizeError, selectedImageUrls, getStoredSettings, saveStoredSettings, copyToClipboard, yieldToMain };})();';

function harness({ failAt = -1, encodeFailure = false, deniedStorage = false, scheduler, dimensions = {}, drawFailure = false, encodedDimensions, encodedDecodeFailure = false } = {}) {
    const state = { closed: [], draws: [], canvas: null, requests: 0, urls: [], decoded: 0, active: 0, maxActive: 0 };
    const values = new Map();
    const encodedSizes = new WeakMap();
    const context = {
        console, Blob, TextEncoder, setTimeout, clearTimeout, performance: { now: () => 100 },
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

const identity={userId:'author',postId:'12345'};
const photo=url=>({type:'photo',media_url_https:url});
const video=(id,variants,type='video')=>({type,id_str:id,video_info:{variants}});
const variant=(url,bitrate,content_type='video/mp4')=>({url,bitrate,content_type});
const payload=media=>({rest_id:'12345',legacy:{extended_entities:{media}}});

test('normalizes original photo URLs consistently across DOM and API',()=>{
    const {api}=harness();
    const expected='https://pbs.twimg.com/media/Photo?format=jpg&name=orig';
    assert.equal(api.normalizeImageUrl('https://pbs.twimg.com/media/Photo.jpg'),expected);
    assert.equal(api.normalizeImageUrl('https://pbs.twimg.com/media/Photo?format=jpg&name=small'),expected);
    assert.equal(api.normalizeImageUrl('https://evil.test/media/Photo.jpg'),'');
});

test('mixed media retain order and choose only the highest-bitrate MP4',()=>{
    const {api}=harness();
    const media=api.mediaFromTweetData(payload([
        photo('https://pbs.twimg.com/media/Photo.jpg'),
        video('v',[variant('https://video.twimg.com/a.m3u8',9000000,'application/x-mpegURL'),variant('https://video.twimg.com/low.mp4',256000),variant('https://video.twimg.com/high.mp4?tag=12',2176000)]),
        video('g',[variant('https://video.twimg.com/tweet_video/Gif.mp4',0)],'animated_gif')
    ]),'12345');
    assert.deepEqual(Array.from(media,m=>m.type),['photo','video','animated_gif']);
    assert.equal(media[1].url,'https://video.twimg.com/high.mp4?tag=12');
    assert.equal(media[2].url,'https://video.twimg.com/tweet_video/Gif.mp4');
});

test('metadata extraction unwraps visibility results and excludes quoted posts',()=>{
    const {api}=harness();
    const data=payload([photo('https://pbs.twimg.com/media/Outer.jpg')]);
    data.quoted_status_result={result:{rest_id:'99999',legacy:{extended_entities:{media:[photo('https://pbs.twimg.com/media/Quote.jpg')]}}}};
    assert.equal(api.mediaFromTweetData({tweet:data},'12345').length,1);
    assert.equal(api.mediaFromTweetData(data,'99999').length,0);
});

test('unified cards and normal tweet data support video extraction',()=>{
    const {api}=harness();
    const card={rest_id:'12345',card:{legacy:{binding_values:[{key:'unified_card',value:{string_value:JSON.stringify({media_entities:{v:video('v',[variant('https://video.twimg.com/card.mp4',832000)])}})}}]}}};
    assert.equal(api.mediaFromTweetData(card,'12345')[0].url,'https://video.twimg.com/card.mp4');
});

test('malformed cards, HLS-only and foreign video URLs cannot become file downloads',()=>{
    const {api}=harness();
    assert.throws(()=>api.mediaFromTweetData(payload([video('v',[variant('https://evil.test/a.mp4',9999999),variant('https://video.twimg.com/a.m3u8',1,'application/x-mpegURL')])]),'12345'), /未提供可下载/);
    assert.equal(api.safeMediaUrl('blob:https://x.com/a','video'),'');
    assert.equal(api.safeMediaUrl('https://video.twimg.com/a.m3u8','video'),'');
    assert.equal(api.safeMediaUrl('https://video.twimg.com/a.mp4?tag=1','video'),'https://video.twimg.com/a.mp4?tag=1');
});

test('React media lookup follows only ancestors for the exact post',()=>{
    const {api}=harness();
    const tweet={__reactFiber$test:{memoizedProps:{},return:{memoizedProps:{tweet:payload([video('v',[variant('https://video.twimg.com/a.mp4',500)])])},return:null}}};
    assert.equal(api.readTweetMedia(tweet,'12345').length,1);
    assert.equal(api.readTweetMedia(tweet,'99999').length,0);
});

test('file names use original MIME extensions, stable indexes and safe characters',()=>{
    const {api}=harness();
    assert.equal(api.mediaFilename(identity,{type:'photo',url:'https://pbs.twimg.com/media/a?format=jpg&name=orig'},0,new Blob(['a'],{type:'image/png'})),'author-12345-image-01.png');
    assert.equal(api.mediaFilename(identity,{type:'animated_gif',url:'https://video.twimg.com/tweet_video/a.mp4'},1,new Blob(['a'])),'author-12345-gif-02.mp4');
    assert.ok(!/[\\/]/.test(api.mediaFilename({userId:'../bad/name',postId:'123'},{type:'video'},0,new Blob(['a']))));
});

function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function unzipStored(bytes){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=[];let offset=0;
    while(view.getUint32(offset,true)===0x04034b50){
        assert.equal(view.getUint16(offset+8,true),0);
        const size=view.getUint32(offset+18,true),nameSize=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);
        const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameSize));
        const start=offset+30+nameSize+extra,data=bytes.slice(start,start+size);
        assert.equal(crc32(data),view.getUint32(offset+14,true));
        files.push({name,data,offset});offset=start+size;
    }
    const centralOffset=offset;
    for(const file of files){assert.equal(view.getUint32(offset,true),0x02014b50);assert.equal(view.getUint32(offset+42,true),file.offset);offset+=46+view.getUint16(offset+28,true);}
    assert.equal(view.getUint32(offset,true),0x06054b50);assert.equal(view.getUint32(offset+16,true),centralOffset);assert.equal(view.getUint16(offset+10,true),files.length);
    return files;
}

test('ZIP preserves filenames, bytes, CRC and directory offsets for mixed files',async()=>{
    const {api}=harness();
    const input=[{name:'原图-01.jpg',blob:new Blob([new Uint8Array([0,1,2,255])])},{name:'video-02.mp4',blob:new Blob(['video-content'])}];
    const blob=await api.buildMediaZip(input);
    assert.equal(blob.type,'application/zip');
    const files=unzipStored(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(files.map(f=>f.name),input.map(f=>f.name));
    for(let i=0;i<files.length;i++)assert.deepEqual(files[i].data,new Uint8Array(await input[i].blob.arrayBuffer()));
});

test('ZIP yields during large-file checksums and supports 20 photos',async()=>{
    let yields=0;
    const {api}=harness({scheduler:{async yield(){yields++;}}});
    const files=Array.from({length:20},(_,i)=>({name:'photo-'+i+'.jpg',blob:new Blob([i===0?new Uint8Array(2200000):'img'])}));
    const zip=await api.buildMediaZip(files);
    assert.equal(unzipStored(new Uint8Array(await zip.arrayBuffer())).length,20);
    assert.ok(yields>=22);
});

test('single-media download preserves original bytes and does not create a ZIP',async()=>{
    const {api,state}=harness();
    const output=await api.prepareMediaDownload([{type:'video',url:'https://video.twimg.com/a.mp4'}],identity);
    assert.equal(output.filename,'author-12345-video-01.mp4');
    assert.equal(await output.blob.text(),'https://video.twimg.com/a.mp4');
    assert.equal(output.count,1);assert.equal(state.requests,1);
});

test('original photo download reuses preview cache without decoding or resizing',async()=>{
    const {api,state}=harness();const cache=api.createImageCache();
    const media=[{type:'photo',url:'https://pbs.twimg.com/media/a?format=jpg&name=orig'},{type:'photo',url:'https://pbs.twimg.com/media/b?format=jpg&name=orig'}];
    await Promise.all(media.map(m=>cache.get(m.url)));
    const output=await api.prepareMediaDownload(media,identity,cache);
    assert.equal(state.requests,2);assert.equal(state.decoded,0);
    assert.equal(output.filename,'author-12345-media.zip');assert.equal(unzipStored(new Uint8Array(await output.blob.arrayBuffer())).length,2);
    cache.dispose();
});

test('failed media request aborts the package instead of reporting partial success',async()=>{
    const {api,state}=harness({failAt:1});
    await assert.rejects(api.prepareMediaDownload([{type:'video',url:'https://video.twimg.com/a.mp4'},{type:'video',url:'https://video.twimg.com/b.mp4'}],identity),/网络错误/);
    assert.equal(state.requests,2);
});

test('unsafe media URL is rejected before making a request',async()=>{
    const {api,state}=harness();
    await assert.rejects(api.prepareMediaDownload([{type:'video',url:'https://foreign.test/a.mp4'}],identity),/媒体地址无效/);
    assert.equal(state.requests,0);
});

test('read-only API requires a login and returns JSON without saving headers',async()=>{
    const {api,context}=harness();context.document.cookie='';
    await assert.rejects(api.fetchTweetMedia('12345'),/请登录/);
    context.document.cookie='unrelated=value; ct0=fixture-csrf';
    let method;
    context.GM_xmlhttpRequest=options=>{method=options.method;assert.equal(new URL(options.url).hostname,'x.com');options.onload({status:200,response:{data:{tweetResult:{result:payload([])}}}});};
    const result=await api.fetchTweetMedia('12345');assert.ok(result.data);assert.equal(method,'GET');
});


test('a corrupt media response cannot be saved as a successful original download',async()=>{
    const {api,context}=harness();context.GM_xmlhttpRequest=o=>o.onload({status:200,response:new Blob(['error page'],{type:'text/html'})});
    await assert.rejects(api.prepareMediaDownload([{type:'video',url:'https://video.twimg.com/a.mp4'}],identity),/媒体文件无效/);
});

test('DOM GIF fallback resolves X tweet_video thumbnails as MP4',()=>{
    const {api}=harness();let tweet;
    const element={src:'https://pbs.twimg.com/tweet_video_thumb/Animated.jpg?name=small',closest(selector){if(selector==='article[data-testid="tweet"]')return tweet;return null;}};
    tweet={querySelectorAll(selector){return selector.startsWith('[data-testid="tweetPhoto"]')?[]:[element];}};
    const media=api.collectDomMedia(tweet);
    assert.equal(media.length,1);assert.equal(media[0].type,'animated_gif');assert.equal(media[0].url,'https://video.twimg.com/tweet_video/Animated.mp4');
});

test('image DOM collection excludes video posters and quoted media',()=>{
    const {api}=harness();let tweet;
    const image=(src,excluded=false,poster=false)=>({src,closest(selector){if(selector==='article[data-testid="tweet"]')return tweet;if(selector.includes('card.wrapper'))return excluded?{}:null;if(selector.includes('videoPlayer'))return poster?{}:null;return null;}});
    const images=[image('https://pbs.twimg.com/media/Original.jpg'),image('https://pbs.twimg.com/media/Quoted.jpg',true),image('https://pbs.twimg.com/media/Poster.jpg',false,true)];
    tweet={querySelectorAll(){return images;}};
    assert.deepEqual(Array.from(api.getImages(tweet)),['https://pbs.twimg.com/media/Original?format=jpg&name=orig']);
});

test('media lookup uses the API when page React media are unavailable',async()=>{
    const {api,context}=harness();context.document.cookie='ct0=fixture';
    let requests=0;context.GM_xmlhttpRequest=o=>{requests++;o.onload({status:200,response:{data:{tweetResult:{result:payload([video('v',[variant('https://video.twimg.com/fallback.mp4',832000)])])}}}});};
    let tweet;const player={closest(selector){return selector.startsWith('article')?tweet:null;}};
    tweet={querySelectorAll(selector){return selector.startsWith('[data-testid="videoPlayer"]')?[player]:[];}};
    const media=await api.getPostMedia(tweet,identity);assert.equal(media[0].url,'https://video.twimg.com/fallback.mp4');assert.equal(requests,1);
});

test('unresolved video does not silently save only its poster',async()=>{
    const {api,context}=harness();context.document.cookie='';let tweet;
    const player={closest(selector){return selector.startsWith('article')?tweet:null;}};
    tweet={querySelectorAll(selector){return selector.startsWith('[data-testid="videoPlayer"]')?[player]:[];}};
    await assert.rejects(api.getPostMedia(tweet,identity),/无法读取视频地址/);
});

test('action-row search stays inside the current post',()=>{
    const {api}=harness();let post;
    const current={parentElement:null};const caret={parentElement:current,closest(){return post;}};
    current.parentElement=post={parentElement:{children:[],contains(){return true;}}};
    current.children=[caret];caret.contains=()=>false;caret.matches=()=>false;caret.querySelector=()=>null;
    post.children=[current];current.contains=node=>node===caret;current.matches=()=>false;current.querySelector=()=>null;
    assert.equal(api.findActionRow(caret),null);
});


test('video progress updates byte feedback and fractional completion',async()=>{
    const {api,context}=harness();
    context.GM_xmlhttpRequest=o=>{o.onprogress({loaded:512,total:1024,lengthComputable:true});o.onload({status:200,response:new Blob(['mp4'],{type:'video/mp4'})});};
    const updates=[];await api.prepareMediaDownload([{type:'video',url:'https://video.twimg.com/a.mp4'}],identity,undefined,(...args)=>updates.push(args));
    assert.ok(updates.some(([message,value,total])=>message.includes('512')&&value===0.5&&total===1));
});


test('isolated page-property access falls back to the read-only media API',async()=>{
    const {api,context}=harness();context.document.cookie='ct0=fixture';
    context.GM_xmlhttpRequest=o=>o.onload({status:200,response:{data:{tweetResult:{result:payload([video('v',[variant('https://video.twimg.com/fallback.mp4',832000)])])}}}});
    let tweet;const player={closest(selector){return selector.startsWith('article')?tweet:null;}};
    tweet={querySelectorAll(selector){return selector.startsWith('[data-testid="videoPlayer"]')?[player]:[];}};
    Object.defineProperty(tweet,'__reactFiber$blocked',{enumerable:true,get(){throw new Error('isolated');}});
    const media=await api.getPostMedia(tweet,identity);assert.equal(media[0].url,'https://video.twimg.com/fallback.mp4');
});
