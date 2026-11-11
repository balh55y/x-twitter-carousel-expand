// ==UserScript==
// @name         X / Twitter 轮播图展开 (画质与体积优化版)
// @namespace    https://github.com/balh55y/x-twitter-carousel-expand
// @version      6.2.1
// @description  展开 X 轮播图，支持图片格式、质量与尺寸设置；桌面导航贴左，保留右上角搜索，支持切换内容宽度
// @author       ChatGPT & DeepSeek
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      pbs.twimg.com
// @connect      abs.twimg.com
// @homepageURL  https://github.com/balh55y/x-twitter-carousel-expand
// @supportURL   https://github.com/balh55y/x-twitter-carousel-expand/issues
// @downloadURL  https://raw.githubusercontent.com/balh55y/x-twitter-carousel-expand/main/x-twitter-carousel-expand.user.js
// @updateURL    https://raw.githubusercontent.com/balh55y/x-twitter-carousel-expand/main/x-twitter-carousel-expand.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '6.2.1';

    const BUTTON_CLASS = '__x_carousel_expand_v6__';
    const OVERLAY_ID = '__x_carousel_overlay_v6__';
    const STYLE_ID = '__x_carousel_style_v6__';
    const WIDTH_BUTTON_ID = '__x_carousel_width_v6__';
    const WIDTH_MODES = [
        { id: 'standard', label: '标准', width: '600px' },
        { id: 'wide', label: '加宽', width: '960px' },
        { id: 'full', label: '全宽', width: '100%' }
    ];

    // 本地持久化配置键名
    const STORAGE_KEYS = {
        FORMAT: '__x_carousel_format_v6__',
        QUALITY: '__x_carousel_quality_v6__',
        SCALE: '__x_carousel_scale_v6__',
        CONTENT_WIDTH: '__x_carousel_content_width_v6__'
    };

    let observer = null;
    let scanTimer = null;

    // ==========================================================
    // 保存用户点击的 Tweet 位置
    // ==========================================================
    let savedPosition = null;

    // ==========================================================
    // 读取与保存设置
    // ==========================================================
    function getStoredSettings() {
        return {
            format: localStorage.getItem(STORAGE_KEYS.FORMAT) || 'image/jpeg',
            quality: parseFloat(localStorage.getItem(STORAGE_KEYS.QUALITY) || '0.85'),
            scaleMode: localStorage.getItem(STORAGE_KEYS.SCALE) || '1'
        };
    }

    function saveStoredSettings(settings) {
        if (settings.format) localStorage.setItem(STORAGE_KEYS.FORMAT, settings.format);
        if (typeof settings.quality === 'number') localStorage.setItem(STORAGE_KEYS.QUALITY, settings.quality.toString());
        if (settings.scaleMode) localStorage.setItem(STORAGE_KEYS.SCALE, settings.scaleMode);
    }

    // ==========================================================
    // 切换桌面内容宽度，刷新页面后保留选择。
    // ==========================================================
    function initWidthControl() {
        if (document.getElementById(WIDTH_BUTTON_ID)) return;

        let storedMode = null;
        try {
            storedMode = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
        } catch {
            // 存储不可用时，仍能切换本次页面的宽度。
        }
        let modeIndex = WIDTH_MODES.findIndex(mode => mode.id === storedMode);
        if (modeIndex < 0) modeIndex = 1;

        const button = document.createElement('button');
        button.id = WIDTH_BUTTON_ID;
        button.type = 'button';

        function applyMode() {
            const mode = WIDTH_MODES[modeIndex];
            const next = WIDTH_MODES[(modeIndex + 1) % WIDTH_MODES.length];
            document.documentElement.style.setProperty('--x-carousel-content-width', mode.width);
            button.dataset.mode = mode.id;
            button.textContent = `切换宽度：${mode.label}`;
            button.title = mode.id === 'full' ? '内容占满导航栏右侧的空间' : `内容宽度上限：${parseInt(mode.width, 10)} px`;
            button.setAttribute('aria-label', `切换内容宽度，当前${mode.label}，下一个${next.label}`);
        }

        button.addEventListener('click', () => {
            modeIndex = (modeIndex + 1) % WIDTH_MODES.length;
            applyMode();
            try {
                localStorage.setItem(STORAGE_KEYS.CONTENT_WIDTH, WIDTH_MODES[modeIndex].id);
            } catch {
                // 本次页面的选择已生效。
            }
        });

        applyMode();
        document.body.appendChild(button);
    }

    // 保留原生搜索组件及搜索建议，避免移动 React 管理的节点。
    function initSearchLayout() {
        let timer = null;
        let markedPath = [];
        let searchHost = null;
        let header = null;
        let columns = null;
        let primary = null;
        const resizeObserver = new ResizeObserver(schedule);

        function schedule() {
            if (timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                sync();
            }, 100);
        }

        function sync() {
            const nextPrimary = document.querySelector('#react-root [data-testid="primaryColumn"]');
            const sidebar = document.querySelector('#react-root [data-testid="sidebarColumn"]');
            const form = sidebar?.querySelector('form[role="search"]');
            if (nextPrimary !== primary) {
                if (primary) resizeObserver.unobserve(primary);
                primary = nextPrimary;
                if (primary) resizeObserver.observe(primary);
            }

            const nextColumns = primary?.parentElement;
            if (nextColumns !== columns) {
                columns?.removeAttribute('data-x-carousel-columns');
                columns = nextColumns;
                columns?.setAttribute('data-x-carousel-columns', '');
            }

            let nextHost = null;
            if (form) {
                nextHost = searchHost?.contains(form) ? searchHost : form;
                if (nextHost === form) {
                    for (let node = form.parentElement; node && node !== sidebar; node = node.parentElement) {
                        if (['fixed', 'sticky'].includes(getComputedStyle(node).position)) {
                            nextHost = node;
                            break;
                        }
                    }
                }
            }

            const nextPath = [];
            for (let node = nextHost; node && node !== sidebar; node = node.parentElement) {
                nextPath.push(node);
            }
            for (const node of markedPath) {
                if (!nextPath.includes(node)) node.removeAttribute('data-x-carousel-search-path');
            }
            for (const node of nextPath) node.setAttribute('data-x-carousel-search-path', '');
            markedPath = nextPath;
            if (searchHost !== nextHost) {
                searchHost?.removeAttribute('data-x-carousel-search-host');
                searchHost = nextHost;
                searchHost?.setAttribute('data-x-carousel-search-host', '');
            }

            const nextHeader = primary && form ? [...primary.querySelectorAll(':scope > div, :scope > div > div')]
                .find(node => getComputedStyle(node).position === 'sticky') : null;
            if (nextHeader !== header) {
                header?.removeAttribute('data-x-carousel-search-header');
                header?.style.removeProperty('--x-carousel-search-inset');
                header = nextHeader;
                header?.setAttribute('data-x-carousel-search-header', '');
            }
            if (header) {
                const inset = innerWidth >= 1000 && searchHost
                    ? Math.max(0, Math.ceil(primary.getBoundingClientRect().right - sidebar.getBoundingClientRect().left + 16)) : 0;
                header.style.setProperty('--x-carousel-search-inset', `${inset}px`);
            }
        }

        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', schedule, { passive: true });
        sync();
    }

    // ==========================================================
    // 工具函数：格式化字节大小
    // ==========================================================
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return bytes.toFixed(0) + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // ==========================================================
    // 注入样式
    // ==========================================================
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* 桌面内容宽度随按钮选择变化。 */
            @media (min-width: 1000px) {
                #react-root:has([data-testid="primaryColumn"]) {
                    --x-carousel-nav-width: 88px;
                }

                #react-root:has([data-testid="primaryColumn"]) header[role="banner"] {
                    flex: 0 0 var(--x-carousel-nav-width) !important;
                    width: var(--x-carousel-nav-width) !important;
                    min-width: 0 !important;
                    align-items: flex-start !important;
                }

                #react-root:has([data-testid="primaryColumn"]) header[role="banner"] > div,
                #react-root:has([data-testid="primaryColumn"]) header[role="banner"] > div > div {
                    width: var(--x-carousel-nav-width) !important;
                    max-width: 100% !important;
                }

                #react-root:has([data-testid="primaryColumn"]) main[role="main"] {
                    flex: 1 1 0% !important;
                    width: 0 !important;
                    min-width: 0 !important;
                    max-width: none !important;
                    align-items: stretch !important;
                }

                #react-root:has([data-testid="primaryColumn"]) main[role="main"] > div {
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: none !important;
                    justify-content: center !important;
                }

                #react-root [data-x-carousel-columns] {
                    justify-content: center !important;
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: none !important;
                }

                #react-root main[role="main"] [data-testid="primaryColumn"] {
                    flex: 1 1 0% !important;
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: var(--x-carousel-content-width, 960px) !important;
                    box-sizing: border-box !important;
                }

                /* 解除信息流内部居中容器和推文卡片的宽度上限。 */
                #react-root [data-testid="primaryColumn"] :is(div, section):has(article[data-testid="tweet"]),
                #react-root [data-testid="primaryColumn"] article[data-testid="tweet"] {
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: none !important;
                    margin-inline: 0 !important;
                    align-self: stretch !important;
                    box-sizing: border-box !important;
                }

                /* 只展开正文和媒体的容器，保留头像、按钮及多图网格。 */
                #react-root [data-testid="primaryColumn"] article[data-testid="tweet"] div:has([data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"]) {
                    min-width: 0 !important;
                    max-width: none !important;
                    margin-inline: 0 !important;
                    align-self: stretch !important;
                    box-sizing: border-box !important;
                }

                #react-root [data-testid="primaryColumn"] article[data-testid="tweet"] [data-testid="tweetText"] {
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: none !important;
                }

                #react-root main[role="main"] [data-testid="sidebarColumn"] {
                    display: none !important;
                }

                #react-root main[role="main"] [data-testid="sidebarColumn"]:has([data-x-carousel-search-host]) {
                    display: flex !important;
                    position: fixed !important;
                    top: 6px !important;
                    right: 16px !important;
                    bottom: auto !important;
                    left: auto !important;
                    width: clamp(200px, 22vw, 350px) !important;
                    min-width: 0 !important;
                    height: auto !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    z-index: 10 !important;
                    overflow: visible !important;
                }

                #react-root [data-testid="sidebarColumn"] > :not([data-x-carousel-search-path]),
                #react-root [data-testid="sidebarColumn"] [data-x-carousel-search-path]:not([data-x-carousel-search-host]) > :not([data-x-carousel-search-path]) {
                    display: none !important;
                }

                #react-root [data-testid="sidebarColumn"] [data-x-carousel-search-path] {
                    position: relative !important;
                    inset: auto !important;
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: none !important;
                    height: auto !important;
                    min-height: 0 !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    box-sizing: border-box !important;
                    overflow: visible !important;
                }

                #react-root [data-x-carousel-search-header] {
                    padding-inline-end: var(--x-carousel-search-inset, 0px) !important;
                    box-sizing: border-box !important;
                }
            }

            @media (min-width: 1265px) {
                #react-root:has([data-testid="primaryColumn"]) {
                    --x-carousel-nav-width: 260px;
                }
            }

            #${WIDTH_BUTTON_ID} {
                display: none !important;
                position: fixed !important;
                right: 20px !important;
                bottom: 148px !important;
                z-index: 9999 !important;
                align-items: center !important;
                justify-content: center !important;
                min-height: 40px !important;
                padding: 10px 16px !important;
                border: 1px solid #536471 !important;
                border-radius: 9999px !important;
                background: #0f1419 !important;
                color: #fff !important;
                font: 600 14px/1.4 system-ui, sans-serif !important;
                white-space: nowrap !important;
                cursor: pointer !important;
                box-shadow: 0 2px 8px rgba(0, 0, 0, .18) !important;
            }

            #${WIDTH_BUTTON_ID}:hover {
                background: #272c30 !important;
            }

            #${WIDTH_BUTTON_ID}:focus-visible {
                outline: 3px solid #1d9bf0 !important;
                outline-offset: 3px !important;
            }

            @media (min-width: 1000px) {
                body:has(#react-root [data-testid="primaryColumn"]) #${WIDTH_BUTTON_ID} {
                    display: inline-flex !important;
                }
            }

            /* 帖子右上角展开按钮 */
            .${BUTTON_CLASS} {
                width: 34px !important;
                height: 34px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                flex: 0 0 34px !important;
                margin: 0 !important;
                padding: 0 !important;
            }

            .${BUTTON_CLASS} > button {
                appearance: none !important;
                width: 34px !important;
                height: 34px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                border-radius: 9999px !important;
                background: transparent !important;
                color: rgb(83, 100, 113) !important;
                cursor: pointer !important;
                transition: background-color .15s ease !important;
            }

            .${BUTTON_CLASS} > button:hover {
                background: rgba(15, 20, 25, .10) !important;
            }

            .${BUTTON_CLASS} svg {
                width: 20px !important;
                height: 20px !important;
                fill: currentColor !important;
                pointer-events: none !important;
            }

            /* 全屏查看器 */
            #${OVERLAY_ID} {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                z-index: 2147483647 !important;
                background: rgba(0, 0, 0, .96) !important;
                overflow: auto !important;
                box-sizing: border-box !important;
                overscroll-behavior: contain !important;
            }

            /* 顶部工具栏 */
            #${OVERLAY_ID} .x-expand-toolbar {
                position: sticky !important;
                top: 0 !important;
                z-index: 20 !important;
                min-height: 56px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                padding: 6px 16px !important;
                box-sizing: border-box !important;
                background: rgba(15, 18, 24, .88) !important;
                backdrop-filter: blur(16px) !important;
                border-bottom: 1px solid rgba(255, 255, 255, .10) !important;
                color: white !important;
                gap: 12px !important;
                flex-wrap: wrap !important;
            }

            #${OVERLAY_ID} .x-toolbar-left {
                display: flex !important;
                align-items: center !important;
                gap: 10px !important;
            }

            #${OVERLAY_ID} .x-expand-title {
                font-size: 14px !important;
                font-weight: 600 !important;
                white-space: nowrap !important;
                color: #f7f9f9 !important;
            }

            /* 控制设置区 */
            #${OVERLAY_ID} .x-toolbar-settings {
                display: flex !important;
                align-items: center !important;
                gap: 10px !important;
                flex-wrap: wrap !important;
            }

            #${OVERLAY_ID} .x-ctrl-group {
                display: inline-flex !important;
                align-items: center !important;
                gap: 6px !important;
                background: rgba(255, 255, 255, .08) !important;
                padding: 4px 10px !important;
                border-radius: 20px !important;
                border: 1px solid rgba(255, 255, 255, .12) !important;
                font-size: 13px !important;
                color: #d1d5db !important;
            }

            #${OVERLAY_ID} .x-ctrl-group label {
                font-size: 12px !important;
                color: #9ca3af !important;
                white-space: nowrap !important;
            }

            #${OVERLAY_ID} .x-select {
                appearance: none !important;
                background: transparent !important;
                border: none !important;
                color: #ffffff !important;
                font-size: 13px !important;
                font-weight: 500 !important;
                cursor: pointer !important;
                outline: none !important;
                padding-right: 14px !important;
                background-image: url('data:image/svg+xml;charset=US-ASCII,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6"><path fill="%23aaa" d="M0 0l5 6 5-6z"/></svg>') !important;
                background-repeat: no-repeat !important;
                background-position: right center !important;
            }

            #${OVERLAY_ID} .x-select option {
                background: #1e232b !important;
                color: #ffffff !important;
            }

            #${OVERLAY_ID} .x-slider-container {
                display: inline-flex !important;
                align-items: center !important;
                gap: 6px !important;
            }

            #${OVERLAY_ID} .x-slider {
                appearance: none !important;
                width: 70px !important;
                height: 4px !important;
                border-radius: 2px !important;
                background: rgba(255, 255, 255, .25) !important;
                outline: none !important;
                cursor: pointer !important;
            }

            #${OVERLAY_ID} .x-slider::-webkit-slider-thumb {
                appearance: none !important;
                width: 14px !important;
                height: 14px !important;
                border-radius: 50% !important;
                background: #1d9bf0 !important;
                cursor: pointer !important;
                transition: transform .1s ease !important;
            }

            #${OVERLAY_ID} .x-slider::-webkit-slider-thumb:hover {
                transform: scale(1.2) !important;
            }

            #${OVERLAY_ID} .x-slider:disabled {
                opacity: 0.3 !important;
                cursor: not-allowed !important;
            }

            #${OVERLAY_ID} .x-quality-val {
                min-width: 32px !important;
                font-size: 12px !important;
                font-weight: 600 !important;
                color: #1d9bf0 !important;
            }

            /* 预估大小气泡 */
            #${OVERLAY_ID} .x-size-badge {
                display: inline-flex !important;
                align-items: center !important;
                gap: 4px !important;
                padding: 4px 10px !important;
                border-radius: 14px !important;
                font-size: 12px !important;
                font-weight: 600 !important;
                background: rgba(34, 197, 94, .15) !important;
                color: #4ade80 !important;
                border: 1px solid rgba(34, 197, 94, .3) !important;
                white-space: nowrap !important;
                transition: all .2s ease !important;
            }

            #${OVERLAY_ID} .x-size-badge.warning {
                background: rgba(234, 179, 8, .18) !important;
                color: #facc15 !important;
                border-color: rgba(234, 179, 8, .4) !important;
            }

            #${OVERLAY_ID} .x-size-badge.loading {
                opacity: 0.6 !important;
                color: #9ca3af !important;
                background: rgba(255, 255, 255, .08) !important;
                border-color: rgba(255, 255, 255, .15) !important;
            }

            /* 工具栏右侧操作区 */
            #${OVERLAY_ID} .x-expand-actions {
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                margin-left: auto !important;
            }

            /* 复制整图按钮 */
            #${OVERLAY_ID} .x-copy-button {
                height: 34px !important;
                padding: 0 16px !important;
                border: 0 !important;
                border-radius: 9999px !important;
                background: #1d9bf0 !important;
                color: white !important;
                font-size: 13px !important;
                font-weight: 600 !important;
                cursor: pointer !important;
                white-space: nowrap !important;
                transition: background .15s ease !important;
            }

            #${OVERLAY_ID} .x-copy-button:hover {
                background: #1a8cd8 !important;
            }

            #${OVERLAY_ID} .x-copy-button:disabled {
                opacity: .55 !important;
                cursor: default !important;
            }

            /* 下载按钮 */
            #${OVERLAY_ID} .x-download-button {
                height: 34px !important;
                padding: 0 12px !important;
                border: 1px solid rgba(255, 255, 255, .2) !important;
                border-radius: 9999px !important;
                background: rgba(255, 255, 255, .10) !important;
                color: white !important;
                font-size: 13px !important;
                font-weight: 500 !important;
                cursor: pointer !important;
                white-space: nowrap !important;
                transition: background .15s ease !important;
            }

            #${OVERLAY_ID} .x-download-button:hover {
                background: rgba(255, 255, 255, .20) !important;
            }

            #${OVERLAY_ID} .x-download-button:disabled {
                opacity: .55 !important;
                cursor: default !important;
            }

            /* 关闭按钮 */
            #${OVERLAY_ID} .x-expand-close {
                width: 34px !important;
                height: 34px !important;
                padding: 0 !important;
                border: 0 !important;
                border-radius: 50% !important;
                background: rgba(255, 255, 255, .12) !important;
                color: white !important;
                font-size: 24px !important;
                line-height: 34px !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                transition: background .15s ease !important;
            }

            #${OVERLAY_ID} .x-expand-close:hover {
                background: rgba(255, 255, 255, .25) !important;
            }

            /* 图片展示区域 */
            #${OVERLAY_ID} .x-expand-content {
                display: flex !important;
                flex-direction: row !important;
                align-items: flex-start !important;
                justify-content: center !important;
                width: max-content !important;
                min-width: 100% !important;
                padding: 20px !important;
                box-sizing: border-box !important;
                gap: 4px !important;
            }

            #${OVERLAY_ID} .x-expand-image {
                display: block !important;
                width: auto !important;
                height: 80vh !important;
                max-width: none !important;
                flex: 0 0 auto !important;
                object-fit: contain !important;
                background: #111 !important;
                border-radius: 4px !important;
                user-select: none !important;
                -webkit-user-drag: none !important;
            }

            /* 底部状态提示浮条 */
            #${OVERLAY_ID} .x-copy-status {
                position: fixed !important;
                left: 50% !important;
                bottom: 24px !important;
                transform: translateX(-50%) !important;
                z-index: 100 !important;
                max-width: calc(100vw - 40px) !important;
                padding: 10px 18px !important;
                box-sizing: border-box !important;
                border-radius: 9999px !important;
                background: rgba(0, 0, 0, .88) !important;
                border: 1px solid rgba(255, 255, 255, .15) !important;
                box-shadow: 0 8px 24px rgba(0, 0, 0, .5) !important;
                color: white !important;
                font-size: 13px !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                pointer-events: none !important;
                opacity: 0 !important;
                transition: opacity .2s ease, transform .2s ease !important;
            }

            #${OVERLAY_ID} .x-copy-status.show {
                opacity: 1 !important;
                transform: translateX(-50%) translateY(-4px) !important;
            }
        `;
        document.head.appendChild(style);
    }

    // ==========================================================
    // 获取帖子中的 X 图片原图链接
    // ==========================================================
    function getImages(tweet) {
        if (!tweet) return [];

        const result = [];
        const seen = new Set();

        let imgs = [...tweet.querySelectorAll('[data-testid="tweetPhoto"] img')];
        if (imgs.length < 2) {
            imgs = [...tweet.querySelectorAll('img[src*="pbs.twimg.com/media/"]')];
        }

        for (const img of imgs) {
            let src = img.currentSrc || img.src || img.getAttribute('src') || '';
            if (!src) continue;

            try {
                const url = new URL(src);
                if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) {
                    url.searchParams.set('name', 'orig');
                }
                src = url.toString();
            } catch {
                // 保留原地址
            }

            if (seen.has(src)) continue;
            seen.add(src);
            result.push(src);
        }

        return result;
    }

    // ==========================================================
    // 查找正确的 Action Row
    // ==========================================================
    function findActionRow(caret) {
        let current = caret;

        for (let i = 0; i < 10; i++) {
            if (!current.parentElement) break;
            const parent = current.parentElement;
            const children = [...parent.children];

            const moreChild = children.find(child => child === current || child.contains(caret));
            const grokChild = children.find(child => !!child.querySelector('button[aria-label="Grok 操作"]'));

            if (moreChild && grokChild && moreChild !== grokChild) {
                return { row: parent, more: moreChild };
            }
            current = parent;
        }

        return null;
    }

    // ==========================================================
    // 添加推文右上角展开按钮
    // ==========================================================
    function addButton(tweet) {
        if (!tweet || !tweet.isConnected) return;
        if (tweet.querySelector(`.${BUTTON_CLASS}`)) return;

        const caret = tweet.querySelector('button[data-testid="caret"]');
        if (!caret) return;

        const images = getImages(tweet);
        if (images.length < 2) return;

        const action = findActionRow(caret);
        if (!action) return;

        const wrapper = document.createElement('div');
        wrapper.className = BUTTON_CLASS;

        const button = document.createElement('button');
        button.type = 'button';
        button.title = `展开并拼接 ${images.length} 张图片`;
        button.setAttribute('aria-label', `展开 ${images.length} 张图片`);
        button.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"></path>
            </svg>
        `;

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            const currentImages = getImages(tweet);
            if (currentImages.length < 2) return;

            saveCurrentPosition(tweet);
            openViewer(currentImages);
        }, true);

        wrapper.appendChild(button);
        action.row.insertBefore(wrapper, action.more);
    }

    // ==========================================================
    // 保存与恢复原帖滚动位置
    // ==========================================================
    function saveCurrentPosition(tweet) {
        const rect = tweet.getBoundingClientRect();
        savedPosition = {
            tweet,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            offsetTop: rect.top,
            offsetLeft: rect.left
        };
    }

    function restorePosition() {
        if (!savedPosition) return;
        const { tweet, scrollX, scrollY, offsetTop, offsetLeft } = savedPosition;

        if (tweet && tweet.isConnected) {
            try {
                const rect = tweet.getBoundingClientRect();
                const targetY = window.scrollY + rect.top - offsetTop;
                const targetX = window.scrollX + rect.left - offsetLeft;
                window.scrollTo(targetX, targetY);
                return;
            } catch {
                // 使用备用位置
            }
        }
        window.scrollTo(scrollX, scrollY);
    }

    function restorePositionMultipleTimes() {
        if (!savedPosition) return;
        requestAnimationFrame(() => {
            restorePosition();
            requestAnimationFrame(() => {
                restorePosition();
                setTimeout(() => {
                    restorePosition();
                    setTimeout(() => {
                        restorePosition();
                        savedPosition = null;
                    }, 150);
                }, 50);
            });
        });
    }

    // ==========================================================
    // Tampermonkey 跨域下载
    // ==========================================================
    function gmRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                timeout: 30000,
                headers: {
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                },
                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        if (response.response) {
                            resolve(response.response);
                            return;
                        }
                        reject(new Error('服务器未返回图片数据'));
                        return;
                    }
                    reject(new Error(`HTTP ${response.status}`));
                },
                onerror: () => reject(new Error('GM_xmlhttpRequest 网络错误')),
                ontimeout: () => reject(new Error('图片下载超时')),
                onabort: () => reject(new Error('图片下载取消'))
            });
        });
    }

    // ==========================================================
    // Blob → ImageBitmap / Image
    // ==========================================================
    async function blobToBitmap(blob) {
        if (typeof createImageBitmap === 'function') {
            return await createImageBitmap(blob);
        }
        const objectURL = URL.createObjectURL(blob);
        try {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = objectURL;
            });
            return img;
        } finally {
            URL.revokeObjectURL(objectURL);
        }
    }

    // ==========================================================
    // 读取所有原图
    // ==========================================================
    async function loadAllImages(urls, onProgress) {
        const bitmaps = [];
        let totalWidth = 0;
        let maxHeight = 0;

        for (let i = 0; i < urls.length; i++) {
            if (onProgress) {
                onProgress(`正在下载原图 (${i + 1}/${urls.length})...`);
            }
            const blob = await gmRequest(urls[i]);
            const bitmap = await blobToBitmap(blob);
            bitmaps.push(bitmap);
            totalWidth += bitmap.width;
            maxHeight = Math.max(maxHeight, bitmap.height);
        }

        return { bitmaps, totalWidth, maxHeight };
    }

    // ==========================================================
    // Canvas 拼接与压缩编码
    // ==========================================================
    async function combineImages(urls, options, onProgress) {
        const { format, quality, scaleMode } = options;
        const { bitmaps, totalWidth, maxHeight } = await loadAllImages(urls, onProgress);

        // 计算目标缩放比
        let scale = 1.0;
        if (scaleMode === 'max-1440') {
            if (maxHeight > 1440) scale = 1440 / maxHeight;
        } else if (scaleMode === 'max-1080') {
            if (maxHeight > 1080) scale = 1080 / maxHeight;
        } else {
            scale = parseFloat(scaleMode) || 1.0;
        }

        const finalWidth = Math.round(totalWidth * scale);
        const finalHeight = Math.round(maxHeight * scale);

        // Canvas 尺寸保护
        const MAX_CANVAS_SIZE = 32767;
        if (finalWidth > MAX_CANVAS_SIZE || finalHeight > MAX_CANVAS_SIZE) {
            throw new Error(`拼接尺寸过大 (${finalWidth}x${finalHeight})，超过浏览器 Canvas 限制`);
        }

        const canvas = document.createElement('canvas');
        canvas.width = finalWidth;
        canvas.height = finalHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');

        // 缩放抗锯齿平滑处理
        ctx.imageSmoothingEnabled = (scale < 1.0);
        if (scale < 1.0) {
            ctx.imageSmoothingQuality = 'high';
        }

        // JPEG 格式不支持透明通道，填充纯白底防止空隙泛黑
        if (format === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, finalWidth, finalHeight);
        }

        // 横向拼接绘制
        let currentX = 0;
        for (const bitmap of bitmaps) {
            const drawW = Math.round(bitmap.width * scale);
            const drawH = Math.round(bitmap.height * scale);
            ctx.drawImage(bitmap, currentX, 0, drawW, drawH);
            currentX += drawW;
        }

        if (onProgress) {
            const fmtName = format === 'image/jpeg' ? 'JPEG' : format === 'image/webp' ? 'WebP' : 'PNG';
            onProgress(`正在进行 ${fmtName} 压缩编码...`);
        }

        // 导出 Blob
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => {
                if (b) resolve(b);
                else reject(new Error('Canvas 导出图片失败'));
            }, format, quality);
        });

        // 释放 ImageBitmap 资源
        for (const bitmap of bitmaps) {
            if (typeof bitmap.close === 'function') bitmap.close();
        }
        canvas.width = 1;
        canvas.height = 1;

        return {
            blob,
            width: finalWidth,
            height: finalHeight,
            size: blob.size
        };
    }

    // ==========================================================
    // 写入系统剪贴板 (带安全回退)
    // ==========================================================
    async function copyToClipboard(blob, mimeType, fallbackBlobProducer) {
        if (!navigator.clipboard || !navigator.clipboard.write) {
            throw new Error('当前浏览器不支持 Async Clipboard API');
        }

        let supported = true;
        if (typeof ClipboardItem !== 'undefined' && typeof ClipboardItem.supports === 'function') {
            try {
                supported = ClipboardItem.supports(mimeType);
            } catch {
                supported = true;
            }
        }

        if (supported) {
            try {
                const item = new ClipboardItem({ [mimeType]: blob });
                await navigator.clipboard.write([item]);
                return { success: true, mimeType, isFallback: false };
            } catch (err) {
                console.warn(`[X轮播展开] 写入 ${mimeType} 到剪贴板被浏览器拒绝:`, err);
            }
        }

        // 兼容回退：如果当前浏览器仅允许 image/png 写入剪贴板
        if (fallbackBlobProducer) {
            const pngBlob = await fallbackBlobProducer();
            const item = new ClipboardItem({ 'image/png': pngBlob });
            await navigator.clipboard.write([item]);
            return { success: true, mimeType: 'image/png', isFallback: true, requestedFormat: mimeType };
        }

        throw new Error(`浏览器剪贴板不支持 ${mimeType} 格式`);
    }

    // ==========================================================
    // 下载图片到本地
    // ==========================================================
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1000);
    }

    // ==========================================================
    // 状态提示
    // ==========================================================
    function showStatus(statusEl, message) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.classList.add('show');
    }

    function hideStatus(statusEl, delay = 0) {
        if (!statusEl) return;
        if (delay > 0) {
            setTimeout(() => statusEl.classList.remove('show'), delay);
        } else {
            statusEl.classList.remove('show');
        }
    }

    // ==========================================================
    // 复制操作处理
    // ==========================================================
    async function handleCopy(urls, copyBtn, statusEl, getOptions) {
        if (copyBtn.disabled) return;

        try {
            copyBtn.disabled = true;
            copyBtn.textContent = '处理中...';

            const options = getOptions();
            showStatus(statusEl, '准备下载原图并进行拼接...');

            const result = await combineImages(urls, options, msg => showStatus(statusEl, msg));

            showStatus(statusEl, `正在写入剪贴板 (${formatBytes(result.size)})...`);

            const copyRes = await copyToClipboard(result.blob, options.format, async () => {
                // 如果浏览器剪贴板只吃 PNG，回退生成同样尺寸的 PNG
                showStatus(statusEl, '当前浏览器限制剪贴板为 PNG，正在生成兼容图...');
                const pngResult = await combineImages(urls, { ...options, format: 'image/png' });
                return pngResult.blob;
            });

            const actualSizeStr = formatBytes(result.size);

            if (copyRes.isFallback) {
                copyBtn.textContent = '✓ 已复制';
                showStatus(statusEl, `✓ 已复制为兼容PNG (${actualSizeStr})。如需极小体积JPG可点击【下载】保存`);
            } else {
                copyBtn.textContent = '✓ 已复制';
                showStatus(statusEl, `✓ 整图已复制到剪贴板！大小: ${actualSizeStr} (${result.width}×${result.height})`);
            }

            setTimeout(() => {
                copyBtn.textContent = '📋 复制整图';
                copyBtn.disabled = false;
                hideStatus(statusEl, 2800);
            }, 1800);

        } catch (error) {
            console.error('[X轮播展开] 复制失败:', error);
            copyBtn.disabled = false;
            copyBtn.textContent = '📋 复制整图';
            showStatus(statusEl, `复制失败：${error?.message || '未知错误'}`);
            hideStatus(statusEl, 4000);
        }
    }

    // ==========================================================
    // 下载操作处理
    // ==========================================================
    async function handleDownload(urls, downloadBtn, statusEl, getOptions) {
        if (downloadBtn.disabled) return;

        try {
            downloadBtn.disabled = true;
            downloadBtn.textContent = '生成中...';

            const options = getOptions();
            showStatus(statusEl, '正在生成文件并准备下载...');

            const result = await combineImages(urls, options, msg => showStatus(statusEl, msg));

            const ext = options.format === 'image/jpeg' ? 'jpg' : options.format === 'image/webp' ? 'webp' : 'png';
            const filename = `x_carousel_${Date.now()}.${ext}`;

            downloadBlob(result.blob, filename);

            downloadBtn.textContent = '✓ 已下载';
            showStatus(statusEl, `✓ 已保存: ${filename} (${formatBytes(result.size)})`);

            setTimeout(() => {
                downloadBtn.textContent = '💾 下载';
                downloadBtn.disabled = false;
                hideStatus(statusEl, 2500);
            }, 1800);

        } catch (error) {
            console.error('[X轮播展开] 下载失败:', error);
            downloadBtn.disabled = false;
            downloadBtn.textContent = '💾 下载';
            showStatus(statusEl, `下载失败：${error?.message || '未知错误'}`);
            hideStatus(statusEl, 4000);
        }
    }

    // ==========================================================
    // 打开查看器
    // ==========================================================
    function openViewer(images) {
        closeViewer(false);

        const stored = getStoredSettings();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        // ------------------------------------------------------
        // Toolbar 结构
        // ------------------------------------------------------
        const toolbar = document.createElement('div');
        toolbar.className = 'x-expand-toolbar';

        // 标题区
        const leftBox = document.createElement('div');
        leftBox.className = 'x-toolbar-left';

        const title = document.createElement('div');
        title.className = 'x-expand-title';
        title.textContent = `轮播图展开 · ${images.length} 张`;
        leftBox.appendChild(title);

        // 设置控制区
        const settingsBox = document.createElement('div');
        settingsBox.className = 'x-toolbar-settings';

        // 1. 复制格式选择
        const fmtGroup = document.createElement('div');
        fmtGroup.className = 'x-ctrl-group';
        fmtGroup.innerHTML = `
            <label>格式:</label>
            <select class="x-select" id="x-format-select" title="选择复制或导出的图片格式">
                <option value="image/jpeg">JPEG (体积小·推荐)</option>
                <option value="image/png">PNG (无损原画)</option>
                <option value="image/webp">WebP (高效压缩)</option>
            </select>
        `;
        const fmtSelect = fmtGroup.querySelector('#x-format-select');
        fmtSelect.value = stored.format;

        // 2. 压缩质量滑块
        const qualityGroup = document.createElement('div');
        qualityGroup.className = 'x-ctrl-group';
        qualityGroup.innerHTML = `
            <label>质量:</label>
            <div class="x-slider-container">
                <input type="range" class="x-slider" id="x-quality-slider" min="30" max="100" step="5" value="${Math.round(stored.quality * 100)}" title="压缩等级：数值越高画质越好，体积也越大">
                <span class="x-quality-val" id="x-quality-label">${Math.round(stored.quality * 100)}%</span>
            </div>
        `;
        const qualitySlider = qualityGroup.querySelector('#x-quality-slider');
        const qualityLabel = qualityGroup.querySelector('#x-quality-label');

        // 3. 分辨率缩放
        const scaleGroup = document.createElement('div');
        scaleGroup.className = 'x-ctrl-group';
        scaleGroup.innerHTML = `
            <label>尺寸:</label>
            <select class="x-select" id="x-scale-select" title="图片分辨率缩放，可在保证清晰度同时极大缩小体积">
                <option value="1">100% (原图分辨率)</option>
                <option value="0.75">75% (高清均衡)</option>
                <option value="0.5">50% (适合社交粘贴)</option>
                <option value="max-1440">限高 1440p</option>
                <option value="max-1080">限高 1080p</option>
            </select>
        `;
        const scaleSelect = scaleGroup.querySelector('#x-scale-select');
        scaleSelect.value = stored.scaleMode;

        // 4. 预测文件大小指示器
        const sizeBadge = document.createElement('div');
        sizeBadge.className = 'x-size-badge loading';
        sizeBadge.innerHTML = '📊 预估: 计算中...';

        settingsBox.appendChild(fmtGroup);
        settingsBox.appendChild(qualityGroup);
        settingsBox.appendChild(scaleGroup);
        settingsBox.appendChild(sizeBadge);

        // 操作区 (复制 / 下载 / 关闭)
        const actions = document.createElement('div');
        actions.className = 'x-expand-actions';

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'x-copy-button';
        copyButton.textContent = '📋 复制整图';
        copyButton.title = '拼接整套轮播图并复制到系统剪贴板';

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'x-download-button';
        downloadButton.textContent = '💾 下载';
        downloadButton.title = '直接将拼接图保存到本地文件';

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'x-expand-close';
        closeButton.textContent = '×';
        closeButton.setAttribute('aria-label', '关闭');

        actions.appendChild(copyButton);
        actions.appendChild(downloadButton);
        actions.appendChild(closeButton);

        toolbar.appendChild(leftBox);
        toolbar.appendChild(settingsBox);
        toolbar.appendChild(actions);

        // ------------------------------------------------------
        // 图片列表展示
        // ------------------------------------------------------
        const content = document.createElement('div');
        content.className = 'x-expand-content';

        const imgElements = [];
        for (let i = 0; i < images.length; i++) {
            const img = document.createElement('img');
            img.className = 'x-expand-image';
            img.src = images[i];
            img.alt = `图片 ${i + 1}`;
            content.appendChild(img);
            imgElements.push(img);
        }

        // 状态栏
        const status = document.createElement('div');
        status.className = 'x-copy-status';

        overlay.appendChild(toolbar);
        overlay.appendChild(content);
        overlay.appendChild(status);
        document.body.appendChild(overlay);

        // 禁止背景滚动
        overlay.dataset.oldBodyOverflow = document.body.style.overflow;
        overlay.dataset.oldHtmlOverflow = document.documentElement.style.overflow;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        // ------------------------------------------------------
        // 获取当前用户设置与预测大小核心算法
        // ------------------------------------------------------
        function getCurrentOptions() {
            return {
                format: fmtSelect.value,
                quality: parseInt(qualitySlider.value, 10) / 100,
                scaleMode: scaleSelect.value
            };
        }

        function updatePrediction() {
            const opts = getCurrentOptions();

            // 滑块交互状态调整
            if (opts.format === 'image/png') {
                qualitySlider.disabled = true;
                qualityLabel.textContent = '无损';
                qualityLabel.style.color = '#9ca3af';
            } else {
                qualitySlider.disabled = false;
                qualityLabel.textContent = `${Math.round(opts.quality * 100)}%`;
                qualityLabel.style.color = '#1d9bf0';
            }

            // 计算已载入的图片宽高
            let totalW = 0;
            let maxH = 0;
            let loadedCount = 0;

            for (const img of imgElements) {
                if (img.naturalWidth && img.naturalHeight) {
                    totalW += img.naturalWidth;
                    maxH = Math.max(maxH, img.naturalHeight);
                    loadedCount++;
                }
            }

            if (loadedCount === 0) {
                sizeBadge.innerHTML = '📊 预估: 测算尺寸中...';
                sizeBadge.className = 'x-size-badge loading';
                return;
            }

            // 部分加载时按比例预估全图尺寸
            const estTotalW = loadedCount === imgElements.length ? totalW : Math.round((totalW / loadedCount) * imgElements.length);
            const estMaxH = maxH;

            // 缩放计算
            let scale = 1.0;
            if (opts.scaleMode === 'max-1440') {
                if (estMaxH > 1440) scale = 1440 / estMaxH;
            } else if (opts.scaleMode === 'max-1080') {
                if (estMaxH > 1080) scale = 1080 / estMaxH;
            } else {
                scale = parseFloat(opts.scaleMode) || 1.0;
            }

            const targetW = Math.round(estTotalW * scale);
            const targetH = Math.round(estMaxH * scale);
            const totalPixels = targetW * targetH;

            // 各格式大小预测经验模型 (字节数)
            let predictedBytes = 0;
            if (opts.format === 'image/png') {
                // PNG 在照片和插图上通常每个像素 1.25~1.5 字节
                predictedBytes = totalPixels * 1.35;
            } else if (opts.format === 'image/webp') {
                predictedBytes = totalPixels * (0.03 + 0.22 * Math.pow(opts.quality, 2.5));
            } else {
                // JPEG: Q85 约为 0.24 字节/像素
                predictedBytes = totalPixels * (0.04 + 0.30 * Math.pow(opts.quality, 2.4));
            }

            const formatted = formatBytes(predictedBytes);
            const isLarge = opts.format === 'image/png' && predictedBytes > 15 * 1024 * 1024;

            if (isLarge) {
                sizeBadge.innerHTML = `⚠️ 预估: <strong>~${formatted}</strong> (${targetW}×${targetH})`;
                sizeBadge.className = 'x-size-badge warning';
                sizeBadge.title = '无损 PNG 体积庞大，建议切换为 JPEG 或降低缩放比例';
            } else {
                sizeBadge.innerHTML = `📊 预估: <strong>~${formatted}</strong> (${targetW}×${targetH})`;
                sizeBadge.className = 'x-size-badge';
                sizeBadge.title = `当前参数下的预估图片体积约为 ${formatted}`;
            }
        }

        // 监听图片加载完毕更新预测尺寸
        for (const img of imgElements) {
            if (img.complete && img.naturalWidth) {
                updatePrediction();
            } else {
                img.addEventListener('load', updatePrediction, { once: true });
            }
        }

        // 选项变动监听
        fmtSelect.addEventListener('change', () => {
            saveStoredSettings(getCurrentOptions());
            updatePrediction();
        });

        qualitySlider.addEventListener('input', () => {
            saveStoredSettings(getCurrentOptions());
            updatePrediction();
        });

        scaleSelect.addEventListener('change', () => {
            saveStoredSettings(getCurrentOptions());
            updatePrediction();
        });

        // 初始更新一次
        updatePrediction();

        // ------------------------------------------------------
        // 绑定按钮事件
        // ------------------------------------------------------
        copyButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            handleCopy(images, copyButton, status, getCurrentOptions);
        });

        downloadButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            handleDownload(images, downloadButton, status, getCurrentOptions);
        });

        closeButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            closeViewer(true);
        });

        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                closeViewer(true);
            }
        });

        // 鼠标滚轮横向滚动
        overlay.addEventListener('wheel', event => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                overlay.scrollLeft += event.deltaY;
            }
            if (event.deltaX !== 0) {
                overlay.scrollLeft += event.deltaX;
            }
            event.preventDefault();
        }, { passive: false });

        // ESC 关闭快捷键
        overlay._keyHandler = event => {
            if (event.key === 'Escape') {
                closeViewer(true);
            }
        };
        document.addEventListener('keydown', overlay._keyHandler);
    }

    // ==========================================================
    // 关闭查看器
    // ==========================================================
    function closeViewer(restore = true) {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;

        if (overlay._keyHandler) {
            document.removeEventListener('keydown', overlay._keyHandler);
        }

        const oldBodyOverflow = overlay.dataset.oldBodyOverflow;
        const oldHtmlOverflow = overlay.dataset.oldHtmlOverflow;
        overlay.remove();

        document.body.style.overflow = oldBodyOverflow || '';
        document.documentElement.style.overflow = oldHtmlOverflow || '';

        if (restore) {
            restorePositionMultipleTimes();
        }
    }

    // ==========================================================
    // 扫描 Tweet
    // ==========================================================
    function scan(root = document) {
        let tweets = [];
        try {
            if (root.matches && root.matches('article[data-testid="tweet"]')) {
                tweets = [root];
            } else if (root.querySelectorAll) {
                tweets = [...root.querySelectorAll('article[data-testid="tweet"]')];
            }
        } catch {
            return;
        }

        for (const tweet of tweets) {
            addButton(tweet);
        }
    }

    function scheduleScan() {
        if (scanTimer !== null) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            scan();
        }, 200);
    }

    // ==========================================================
    // MutationObserver 监听动态推文加载
    // ==========================================================
    observer = new MutationObserver(mutations => {
        let shouldScan = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches?.(`.${BUTTON_CLASS}`) || node.querySelector?.(`.${BUTTON_CLASS}`)) continue;
                if (node.matches?.(`#${OVERLAY_ID}`)) continue;
                if (node.matches?.('article[data-testid="tweet"]') || node.querySelector?.('article[data-testid="tweet"]')) {
                    shouldScan = true;
                    break;
                }
            }
            if (shouldScan) break;
        }
        if (shouldScan) scheduleScan();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // ==========================================================
    // 初始化执行
    // ==========================================================
    injectStyle();
    initWidthControl();
    initSearchLayout();
    scan();
    console.log(`[X轮播展开] v${VERSION} 已启动 (支持格式选择/压缩调节/体积预估)`);
})();
