// ==UserScript==
// @name         X / Twitter 轮播图展开 (画质与体积优化版)
// @namespace    https://github.com/balh55y/x-twitter-carousel-expand
// @version      6.3.0
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

    const VERSION = '6.3.0';

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

    const sessionSettings = new Map();
    const pendingTweets = new Set();
    let scanScheduled = false;

    // ==========================================================
    // 读取与保存设置
    // ==========================================================
    function readSetting(key) {
        if (sessionSettings.has(key)) return sessionSettings.get(key);
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeSetting(key, value) {
        sessionSettings.set(key, String(value));
        try {
            localStorage.setItem(key, String(value));
        } catch {
            // 存储不可用时，设置仍在本次页面中生效。
        }
    }

    function getStoredSettings() {
        const format = readSetting(STORAGE_KEYS.FORMAT);
        const quality = Number.parseFloat(readSetting(STORAGE_KEYS.QUALITY));
        const scaleMode = readSetting(STORAGE_KEYS.SCALE);
        return {
            format: ['image/jpeg', 'image/png', 'image/webp'].includes(format) ? format : 'image/jpeg',
            quality: Number.isFinite(quality) ? Math.min(1, Math.max(0.3, quality)) : 0.85,
            scaleMode: ['1', '0.75', '0.5', 'max-1440', 'max-1080'].includes(scaleMode) ? scaleMode : '1'
        };
    }

    function saveStoredSettings(settings) {
        if (settings.format) writeSetting(STORAGE_KEYS.FORMAT, settings.format);
        if (Number.isFinite(settings.quality)) writeSetting(STORAGE_KEYS.QUALITY, settings.quality);
        if (settings.scaleMode) writeSetting(STORAGE_KEYS.SCALE, settings.scaleMode);
    }

    // ==========================================================
    // 切换桌面内容宽度，刷新页面后保留选择。
    // ==========================================================
    function initWidthControl(onWidthChange) {
        if (document.getElementById(WIDTH_BUTTON_ID)) return;

        const storedMode = readSetting(STORAGE_KEYS.CONTENT_WIDTH);
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
            button.setAttribute('aria-label', button.textContent);
            button.setAttribute('aria-description', `下一个：${next.label}`);
            onWidthChange();
        }

        button.addEventListener('click', () => {
            modeIndex = (modeIndex + 1) % WIDTH_MODES.length;
            applyMode();
            writeSetting(STORAGE_KEYS.CONTENT_WIDTH, WIDTH_MODES[modeIndex].id);
        });

        applyMode();
        document.body.appendChild(button);
    }

    // 保留原生搜索组件及搜索建议，避免移动 React 管理的节点。
    function initSearchLayout() {
        let frame = null;
        let markedPath = [];
        let searchHost = null;
        let header = null;
        let columns = null;
        let primary = null;
        let observedSidebar = null;
        const observedWidths = new WeakMap();
        const resizeObserver = new ResizeObserver(entries => {
            let changed = false;
            for (const entry of entries) {
                if (entry.contentRect.width !== observedWidths.get(entry.target)) {
                    observedWidths.set(entry.target, entry.contentRect.width);
                    changed = true;
                }
            }
            if (changed) schedule();
        });

        function schedule() {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                sync();
            });
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
            if (sidebar !== observedSidebar) {
                if (observedSidebar) resizeObserver.unobserve(observedSidebar);
                observedSidebar = sidebar;
                if (sidebar) resizeObserver.observe(sidebar);
            }

            const nextColumns = primary?.parentElement;

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
            const nextHeader = primary && form ? [...primary.querySelectorAll(':scope > div, :scope > div > div')]
                .find(node => getComputedStyle(node).position === 'sticky') : null;

            // 样式读取完成后，再集中更新布局标记。
            if (nextColumns !== columns) {
                columns?.removeAttribute('data-x-carousel-columns');
                columns = nextColumns;
                columns?.setAttribute('data-x-carousel-columns', '');
            }
            for (const node of markedPath) {
                if (!nextPath.includes(node)) node.removeAttribute('data-x-carousel-search-path');
            }
            for (const node of nextPath) {
                if (!node.hasAttribute('data-x-carousel-search-path')) node.setAttribute('data-x-carousel-search-path', '');
            }
            markedPath = nextPath;
            if (searchHost !== nextHost) {
                searchHost?.removeAttribute('data-x-carousel-search-host');
                searchHost = nextHost;
                searchHost?.setAttribute('data-x-carousel-search-host', '');
            }

            if (nextHeader !== header) {
                header?.removeAttribute('data-x-carousel-search-header');
                header?.style.removeProperty('--x-carousel-search-inset');
                header = nextHeader;
                header?.setAttribute('data-x-carousel-search-header', '');
            }
            if (header) {
                requestAnimationFrame(() => {
                    if (!header?.isConnected || !primary?.isConnected || !sidebar?.isConnected) return;
                    const searchRect = sidebar.getBoundingClientRect();
                    const inset = innerWidth >= 1000 && searchHost && searchRect.width > 0
                        ? Math.max(0, Math.ceil(primary.getBoundingClientRect().right - searchRect.left + 16)) : 0;
                    const value = `${inset}px`;
                    if (header.style.getPropertyValue('--x-carousel-search-inset') !== value) {
                        header.style.setProperty('--x-carousel-search-inset', value);
                    }
                });
            }
        }

        const layoutSelector = '[data-testid="primaryColumn"], [data-testid="sidebarColumn"], form[role="search"]';
        new MutationObserver(mutations => {
            for (const mutation of mutations) {
                const target = mutation.target;
                if (target.closest?.(`article[data-testid="tweet"], #${OVERLAY_ID}, form[role="search"]`)) continue;
                if (target === header?.parentElement ||
                    [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
                        node.nodeType === 1 && (node.matches(layoutSelector) || node.querySelector(layoutSelector)))) {
                    schedule();
                    break;
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', schedule, { passive: true });
        sync();
        return schedule;
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

            /* 查看器采用独立的浅色界面。 */
            #${OVERLAY_ID} {
                position: fixed !important;
                inset: 0 !important;
                inline-size: 100% !important;
                block-size: 100% !important;
                max-inline-size: none !important;
                max-block-size: none !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                background: #f3f4f5 !important;
                color: #25292d !important;
                color-scheme: only light !important;
                font: 14px/1.5 system-ui, sans-serif !important;
                overflow: auto !important;
                overscroll-behavior: contain !important;
                box-sizing: border-box !important;
            }

            #${OVERLAY_ID}[open] {
                display: flex !important;
                flex-direction: column !important;
            }

            #${OVERLAY_ID}::backdrop {
                background: rgba(30, 34, 38, .18);
                overflow: hidden;
                overscroll-behavior: contain;
            }

            #${OVERLAY_ID} .x-expand-toolbar {
                display: flex !important;
                flex: 0 0 auto !important;
                align-items: center !important;
                flex-wrap: wrap !important;
                gap: 16px 24px !important;
                padding: 16px 24px !important;
                border-block-end: 1px solid #d8dce0 !important;
                background: #fff !important;
                color: #25292d !important;
                box-sizing: border-box !important;
            }

            #${OVERLAY_ID} .x-toolbar-left {
                display: flex !important;
                align-items: baseline !important;
                gap: 12px !important;
                flex: 0 0 auto !important;
            }

            #${OVERLAY_ID} .x-expand-title {
                margin: 0 !important;
                font: 600 16px/1.5 system-ui, sans-serif !important;
                color: #25292d !important;
            }

            #${OVERLAY_ID} .x-image-count {
                color: #596168 !important;
                font-size: 13px !important;
                white-space: nowrap !important;
            }

            #${OVERLAY_ID} .x-toolbar-settings {
                display: flex !important;
                flex: 1 1 auto !important;
                align-items: center !important;
                flex-wrap: wrap !important;
                gap: 12px 20px !important;
                min-inline-size: 0 !important;
            }

            #${OVERLAY_ID} .x-ctrl-group,
            #${OVERLAY_ID} .x-slider-container {
                display: inline-flex !important;
                align-items: center !important;
                gap: 8px !important;
            }

            #${OVERLAY_ID} .x-ctrl-group label {
                color: #535b62 !important;
                font-size: 13px !important;
                white-space: nowrap !important;
            }

            #${OVERLAY_ID} .x-select {
                appearance: auto !important;
                min-block-size: 36px !important;
                padding: 4px 8px !important;
                border: 1px solid #858b91 !important;
                border-radius: 5px !important;
                background: #fff !important;
                color: #25292d !important;
                font: inherit !important;
                cursor: pointer !important;
            }

            #${OVERLAY_ID} .x-slider {
                appearance: auto !important;
                inline-size: 88px !important;
                min-block-size: 24px !important;
                margin: 0 !important;
                accent-color: #434b52 !important;
                cursor: pointer !important;
            }

            #${OVERLAY_ID} .x-quality-val {
                min-inline-size: 36px !important;
                color: #535b62 !important;
                font-variant-numeric: tabular-nums !important;
                font-size: 13px !important;
            }

            #${OVERLAY_ID} .x-size-badge {
                color: #596168 !important;
                font-size: 12px !important;
                font-variant-numeric: tabular-nums !important;
                overflow-wrap: anywhere !important;
            }

            #${OVERLAY_ID} .x-size-badge.warning {
                color: #805000 !important;
            }

            #${OVERLAY_ID} .x-expand-actions {
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                margin-inline-start: auto !important;
            }

            #${OVERLAY_ID} .x-expand-actions > button {
                min-block-size: 36px !important;
                padding: 6px 12px !important;
                border: 1px solid #858b91 !important;
                border-radius: 5px !important;
                background: #fff !important;
                color: #30373d !important;
                font: 500 13px/1.5 system-ui, sans-serif !important;
                white-space: nowrap !important;
                cursor: pointer !important;
            }

            #${OVERLAY_ID} .x-expand-actions > .x-copy-button {
                border-color: #30373d !important;
                background: #30373d !important;
                color: #fff !important;
            }

            #${OVERLAY_ID} .x-expand-actions > button:hover {
                background: #f0f2f4 !important;
            }

            #${OVERLAY_ID} .x-expand-actions > .x-copy-button:hover {
                background: #4b535a !important;
            }

            #${OVERLAY_ID} .x-expand-actions > button:disabled,
            #${OVERLAY_ID} .x-slider:disabled {
                opacity: .5 !important;
                cursor: default !important;
            }

            #${OVERLAY_ID} .x-expand-viewport {
                flex: 1 1 auto !important;
                min-block-size: 0 !important;
                min-inline-size: 0 !important;
                padding: 24px !important;
                overflow: auto !important;
                overscroll-behavior: contain !important;
                box-sizing: border-box !important;
            }

            #${OVERLAY_ID} .x-expand-content {
                display: flex !important;
                align-items: center !important;
                justify-content: safe center !important;
                inline-size: max-content !important;
                min-inline-size: 100% !important;
                block-size: 100% !important;
                gap: 2px !important;
            }

            #${OVERLAY_ID} .x-expand-image {
                display: block !important;
                flex: 0 0 auto !important;
                inline-size: auto !important;
                block-size: 100% !important;
                max-inline-size: none !important;
                object-fit: contain !important;
                background: #fff !important;
                user-select: none !important;
                -webkit-user-drag: none !important;
            }

            #${OVERLAY_ID} .x-copy-status {
                position: fixed !important;
                inset-inline-start: 50% !important;
                inset-block-end: 20px !important;
                transform: translateX(-50%) !important;
                max-inline-size: calc(100% - 32px) !important;
                padding: 10px 16px !important;
                border: 1px solid #858b91 !important;
                border-radius: 5px !important;
                background: #fff !important;
                color: #30373d !important;
                font-size: 13px !important;
                overflow-wrap: anywhere !important;
                pointer-events: none !important;
                opacity: 0 !important;
                box-sizing: border-box !important;
            }

            #${OVERLAY_ID} .x-copy-status.show {
                opacity: 1 !important;
            }

            #${OVERLAY_ID} :is(button, select, input):focus-visible,
            .${BUTTON_CLASS} > button:focus-visible {
                outline: 3px solid #005fcc !important;
                outline-offset: 3px !important;
            }

            #${OVERLAY_ID} .x-export-progress {
                inline-size: min(160px, 60vw);
                accent-color: #434b52;
            }

            #${OVERLAY_ID} .x-export-progress[hidden] {
                display: none !important;
            }

            @media (width < 720px) {
                #${OVERLAY_ID} .x-expand-toolbar {
                    gap: 12px !important;
                    padding: 12px 16px !important;
                }
                #${OVERLAY_ID} .x-toolbar-settings {
                    flex-basis: 100% !important;
                    gap: 10px 16px !important;
                }
                #${OVERLAY_ID} .x-expand-actions {
                    margin-inline-start: 0 !important;
                }
                #${OVERLAY_ID} .x-expand-viewport {
                    padding: 12px !important;
                }
            }

            @media (forced-colors: active) {
                #${OVERLAY_ID}, #${OVERLAY_ID} .x-expand-toolbar {
                    background: Canvas !important;
                    color: CanvasText !important;
                }
                #${OVERLAY_ID} :is(.x-select, .x-expand-actions > button, .x-copy-status) {
                    border-color: ButtonText !important;
                    background: ButtonFace !important;
                    color: ButtonText !important;
                }
                #${OVERLAY_ID} :is(button, select, input):focus-visible {
                    outline-color: Highlight !important;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                .${BUTTON_CLASS} > button {
                    transition: none !important;
                }
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
        const existing = tweet.querySelector(`.${BUTTON_CLASS}`);
        const images = getImages(tweet);
        if (images.length < 2) {
            existing?.remove();
            return;
        }
        if (existing) {
            const button = existing.querySelector('button');
            const label = `展开 ${images.length} 张图片`;
            if (button.getAttribute('aria-label') !== label) {
                button.setAttribute('aria-label', label);
                button.title = `展开并拼接 ${images.length} 张图片`;
            }
            return;
        }

        const caret = tweet.querySelector('button[data-testid="caret"]');
        if (!caret) return;

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

            openViewer(currentImages);
        }, true);

        wrapper.appendChild(button);
        action.row.insertBefore(wrapper, action.more);
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
    function releaseBitmaps(bitmaps) {
        for (const bitmap of bitmaps) {
            if (typeof bitmap.close === 'function') bitmap.close();
        }
    }

    async function loadAllImages(urls, onProgress) {
        const bitmaps = [];
        let totalWidth = 0;
        let maxHeight = 0;
        try {
            for (let i = 0; i < urls.length; i++) {
                onProgress?.(`正在下载原图（${i + 1}/${urls.length}）`);
                const blob = await gmRequest(urls[i]);
                const bitmap = await blobToBitmap(blob);
                bitmaps.push(bitmap);
                totalWidth += bitmap.width;
                maxHeight = Math.max(maxHeight, bitmap.height);
            }
            return { bitmaps, totalWidth, maxHeight };
        } catch (error) {
            releaseBitmaps(bitmaps);
            throw error;
        }
    }

    // 无论绘制或编码是否成功，都释放图片和画布资源。
    async function combineImages(urls, options, onProgress) {
        const { format, quality, scaleMode } = options;
        const { bitmaps, totalWidth, maxHeight } = await loadAllImages(urls, onProgress);
        let canvas;
        try {
            let scale = 1;
            if (scaleMode === 'max-1440') {
                scale = Math.min(1, 1440 / maxHeight);
            } else if (scaleMode === 'max-1080') {
                scale = Math.min(1, 1080 / maxHeight);
            } else {
                scale = Number.parseFloat(scaleMode) || 1;
            }
            const finalWidth = Math.round(totalWidth * scale);
            const finalHeight = Math.round(maxHeight * scale);
            const MAX_CANVAS_SIZE = 32767;
            if (finalWidth < 1 || finalHeight < 1 || finalWidth > MAX_CANVAS_SIZE || finalHeight > MAX_CANVAS_SIZE) {
                throw new Error(`无法导出 ${finalWidth}×${finalHeight} 图片，请降低尺寸后重试`);
            }

            canvas = document.createElement('canvas');
            canvas.width = finalWidth;
            canvas.height = finalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('无法创建画布，请降低尺寸后重试');
            ctx.imageSmoothingEnabled = scale < 1;
            if (scale < 1) ctx.imageSmoothingQuality = 'high';
            if (format === 'image/jpeg') {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, finalWidth, finalHeight);
            }

            let sourceX = 0;
            let deadline = performance.now() + 8;
            for (const bitmap of bitmaps) {
                const left = Math.round(sourceX * scale);
                sourceX += bitmap.width;
                const right = Math.round(sourceX * scale);
                const drawHeight = Math.round(bitmap.height * scale);
                ctx.drawImage(bitmap, left, 0, right - left, drawHeight);
                if (performance.now() >= deadline) {
                    await yieldToMain();
                    deadline = performance.now() + 8;
                }
            }

            const fmtName = format === 'image/jpeg' ? 'JPEG' : format === 'image/webp' ? 'WebP' : 'PNG';
            onProgress?.(`正在编码 ${fmtName} 图片`);
            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob(result => {
                    if (result) resolve(result);
                    else reject(new Error('图片编码失败，请降低尺寸后重试'));
                }, format, quality);
            });
            return { blob, width: finalWidth, height: finalHeight, size: blob.size, format: blob.type || format };
        } finally {
            releaseBitmaps(bitmaps);
            if (canvas) {
                canvas.width = 1;
                canvas.height = 1;
            }
        }
    }

    // ==========================================================
    // 写入系统剪贴板 (带安全回退)
    // ==========================================================
    async function copyToClipboard(blob, mimeType, fallbackBlobProducer) {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
            throw new Error('浏览器不支持复制图片，请使用下载');
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
                return { success: true, mimeType, isFallback: false, size: blob.size };
            } catch (err) {
                console.warn(`[X轮播展开] 写入 ${mimeType} 到剪贴板被浏览器拒绝:`, err);
            }
        }

        // 兼容回退：如果当前浏览器仅允许 image/png 写入剪贴板
        if (fallbackBlobProducer) {
            const pngBlob = await fallbackBlobProducer();
            const item = new ClipboardItem({ 'image/png': pngBlob });
            await navigator.clipboard.write([item]);
            return { success: true, mimeType: 'image/png', isFallback: true, requestedFormat: mimeType, size: pngBlob.size };
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
            a.remove();
            URL.revokeObjectURL(url);
        }, 1000);
    }

    // ==========================================================
    // 状态提示
    // ==========================================================
    function showStatus(statusEl, message, announce = true) {
        if (!statusEl) return;
        statusEl.setAttribute('aria-live', announce ? 'polite' : 'off');
        statusEl.textContent = message;
        statusEl.classList.add('show');
    }

    function setExportBusy(statusEl, busy) {
        const dialog = statusEl.closest('dialog');
        statusEl._exporting = busy;
        statusEl._progress.hidden = !busy;
        for (const button of dialog.querySelectorAll('.x-copy-button, .x-download-button')) {
            button.disabled = busy;
        }
        const closeButton = dialog.querySelector('.x-expand-close');
        if (busy) closeButton.focus({ preventScroll: true });
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
        if (copyBtn.disabled || statusEl._exporting) return;
        setExportBusy(statusEl, true);

        try {
            copyBtn.disabled = true;
            copyBtn.textContent = '处理中...';

            const options = getOptions();
            showStatus(statusEl, '正在准备原图', false);

            const result = await combineImages(urls, options, msg => showStatus(statusEl, msg, false));

            showStatus(statusEl, `正在写入剪贴板（${formatBytes(result.size)}）`, false);

            const copyRes = await copyToClipboard(result.blob, result.format, async () => {
                // 如果浏览器剪贴板只吃 PNG，回退生成同样尺寸的 PNG
                showStatus(statusEl, '正在生成剪贴板支持的 PNG 图片', false);
                const pngResult = await combineImages(urls, { ...options, format: 'image/png' });
                return pngResult.blob;
            });

            const actualSizeStr = formatBytes(copyRes.size);

            if (copyRes.isFallback) {
                copyBtn.textContent = '已复制';
                showStatus(statusEl, `已复制为 PNG（${actualSizeStr}）`);
            } else {
                copyBtn.textContent = '已复制';
                showStatus(statusEl, `已复制（${actualSizeStr}，${result.width}×${result.height}）`);
            }

            setTimeout(() => {
                copyBtn.textContent = '复制整图';
                hideStatus(statusEl, 2800);
            }, 1800);

        } catch (error) {
            console.error('[X轮播展开] 复制失败:', error);
            copyBtn.textContent = '复制整图';
            showStatus(statusEl, `复制失败：${error?.message || '未知错误'}`);
            hideStatus(statusEl, 4000);
        } finally {
            setExportBusy(statusEl, false);
        }
    }

    // ==========================================================
    // 下载操作处理
    // ==========================================================
    async function handleDownload(urls, downloadBtn, statusEl, getOptions) {
        if (downloadBtn.disabled || statusEl._exporting) return;
        setExportBusy(statusEl, true);

        try {
            downloadBtn.disabled = true;
            downloadBtn.textContent = '生成中...';

            const options = getOptions();
            showStatus(statusEl, '正在生成下载文件', false);

            const result = await combineImages(urls, options, msg => showStatus(statusEl, msg, false));

            const ext = result.format === 'image/jpeg' ? 'jpg' : result.format === 'image/webp' ? 'webp' : 'png';
            const filename = `x_carousel_${Date.now()}.${ext}`;

            downloadBlob(result.blob, filename);

            downloadBtn.textContent = '已下载';
            showStatus(statusEl, `已保存： ${filename} (${formatBytes(result.size)})`);

            setTimeout(() => {
                downloadBtn.textContent = '下载';
                hideStatus(statusEl, 2500);
            }, 1800);

        } catch (error) {
            console.error('[X轮播展开] 下载失败:', error);
            downloadBtn.textContent = '下载';
            showStatus(statusEl, `下载失败：${error?.message || '未知错误'}`);
            hideStatus(statusEl, 4000);
        } finally {
            setExportBusy(statusEl, false);
        }
    }

    // ==========================================================
    // 打开查看器
    // ==========================================================
    function openViewer(images) {
        closeViewer();

        const stored = getStoredSettings();

        const overlay = document.createElement('dialog');
        overlay.id = OVERLAY_ID;
        overlay.lang = 'zh-CN';
        overlay.setAttribute('aria-labelledby', `${OVERLAY_ID}_title`);
        overlay.setAttribute('closedby', 'any');
        overlay.addEventListener('close', () => overlay.remove(), { once: true });

        // ------------------------------------------------------
        // Toolbar 结构
        // ------------------------------------------------------
        const toolbar = document.createElement('div');
        toolbar.className = 'x-expand-toolbar';

        // 标题区
        const leftBox = document.createElement('div');
        leftBox.className = 'x-toolbar-left';

        const title = document.createElement('h2');
        title.id = `${OVERLAY_ID}_title`;
        title.className = 'x-expand-title';
        title.textContent = '图片预览';
        const count = document.createElement('span');
        count.className = 'x-image-count';
        count.textContent = `${images.length} 张`;
        leftBox.appendChild(count);
        leftBox.prepend(title);

        // 设置控制区
        const settingsBox = document.createElement('div');
        settingsBox.className = 'x-toolbar-settings';

        // 1. 复制格式选择
        const fmtGroup = document.createElement('div');
        fmtGroup.className = 'x-ctrl-group';
        fmtGroup.innerHTML = `
            <label for="x-format-select">格式：</label>
            <select class="x-select" id="x-format-select" title="选择复制或导出的图片格式">
                <option value="image/jpeg">JPEG</option>
                <option value="image/png">PNG</option>
                <option value="image/webp">WebP</option>
            </select>
        `;
        const fmtSelect = fmtGroup.querySelector('#x-format-select');
        fmtSelect.value = stored.format;

        // 2. 压缩质量滑块
        const qualityGroup = document.createElement('div');
        qualityGroup.className = 'x-ctrl-group';
        qualityGroup.innerHTML = `
            <label for="x-quality-slider">质量：</label>
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
            <label for="x-scale-select">尺寸：</label>
            <select class="x-select" id="x-scale-select" title="导出图片相对原图的尺寸">
                <option value="1">100%（原图）</option>
                <option value="0.75">75%</option>
                <option value="0.5">50%</option>
                <option value="max-1440">限高 1440p</option>
                <option value="max-1080">限高 1080p</option>
            </select>
        `;
        const scaleSelect = scaleGroup.querySelector('#x-scale-select');
        scaleSelect.value = stored.scaleMode;

        // 4. 预测文件大小指示器
        const sizeBadge = document.createElement('div');
        sizeBadge.className = 'x-size-badge loading';
        sizeBadge.textContent = '正在读取图片尺寸';

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
        copyButton.textContent = '复制整图';
        copyButton.title = '拼接整套轮播图并复制到系统剪贴板';

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'x-download-button';
        downloadButton.textContent = '下载';
        downloadButton.title = '直接将拼接图保存到本地文件';

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'x-expand-close';
        closeButton.textContent = '关闭';
        closeButton.setAttribute('aria-label', '关闭');
        closeButton.autofocus = true;

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
        const viewport = document.createElement('div');
        viewport.className = 'x-expand-viewport';
        viewport.appendChild(content);

        const imgElements = [];
        for (let i = 0; i < images.length; i++) {
            const img = document.createElement('img');
            img.className = 'x-expand-image';
            img.alt = `图片 ${i + 1}`;
            img.decoding = 'async';
            img.loading = i === 0 ? 'eager' : 'lazy';
            img.src = images[i];
            content.appendChild(img);
            imgElements.push(img);
        }

        // 状态栏
        const status = document.createElement('div');
        status.className = 'x-copy-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'off');
        const progress = document.createElement('progress');
        progress.className = 'x-export-progress';
        progress.setAttribute('aria-label', '生成图片');
        progress.hidden = true;
        status._progress = progress;
        toolbar.appendChild(progress);

        overlay.appendChild(toolbar);
        overlay.appendChild(viewport);
        overlay.appendChild(status);
        document.body.appendChild(overlay);

        overlay.showModal();

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
            } else {
                qualitySlider.disabled = false;
                qualityLabel.textContent = `${Math.round(opts.quality * 100)}%`;
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
                sizeBadge.textContent = '正在读取图片尺寸';
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
                sizeBadge.textContent = `预估约 ${formatted} · ${targetW}×${targetH}（预估超过 15 MB）`;
                sizeBadge.className = 'x-size-badge warning';
                sizeBadge.title = '预计超过 15 MB，可降低尺寸或选择 JPEG';
            } else {
                sizeBadge.textContent = `预估约 ${formatted} · ${targetW}×${targetH}`;
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
            closeViewer();
        });

        overlay.addEventListener('click', event => {
            event.stopPropagation();
        });

        // 仅把媒体区的普通鼠标滚轮转换为横向滚动。
        content.addEventListener('wheel', event => {
            if (event.ctrlKey || event.shiftKey || event.deltaX || !event.deltaY ||
                viewport.scrollWidth <= viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight + 1) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
            const previous = viewport.scrollLeft;
            viewport.scrollLeft += event.deltaY * unit;
            if (viewport.scrollLeft !== previous) event.preventDefault();
        }, { passive: false });

        if (!('closedBy' in HTMLDialogElement.prototype)) {
            const outside = event => {
                const rect = overlay.getBoundingClientRect();
                return event.clientX < rect.left || event.clientX > rect.right ||
                    event.clientY < rect.top || event.clientY > rect.bottom;
            };
            let pressedOutside = false;
            overlay.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
            overlay.addEventListener('pointerup', event => {
                if (pressedOutside && outside(event)) overlay.close();
            });
        }
    }

    // ==========================================================
    // 关闭查看器
    // ==========================================================
    function closeViewer() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;

        if (overlay.open) overlay.close();
        overlay.remove();
    }

    // ==========================================================
    // 扫描 Tweet
    // ==========================================================
    function queueTweets(root) {
        if (root.matches?.('article[data-testid="tweet"]')) pendingTweets.add(root);
        for (const tweet of root.querySelectorAll?.('article[data-testid="tweet"]') || []) {
            pendingTweets.add(tweet);
        }
        if (scanScheduled || !pendingTweets.size) return;
        scanScheduled = true;
        flushTweets();
    }

    async function yieldToMain() {
        if (typeof globalThis.scheduler?.yield === 'function') {
            await globalThis.scheduler.yield();
        } else {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    async function flushTweets() {
        try {
            while (pendingTweets.size) {
                await new Promise((resolve, reject) => requestAnimationFrame(() => {
                    try {
                        const deadline = performance.now() + 8;
                        let count = 0;
                        for (const tweet of pendingTweets) {
                            pendingTweets.delete(tweet);
                            if (tweet.isConnected) addButton(tweet);
                            if (++count >= 20 || performance.now() >= deadline) break;
                        }
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }));
                if (pendingTweets.size) await yieldToMain();
            }
        } catch (error) {
            console.warn('[X轮播展开] 添加展开按钮失败:', error);
        } finally {
            scanScheduled = false;
            if (pendingTweets.size) queueTweets(document.createDocumentFragment());
        }
    }

    // 仅检查新增或内部变化的推文，忽略脚本自己的界面更新。
    new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.target.closest?.('#' + OVERLAY_ID + ', .' + BUTTON_CLASS)) continue;
            const tweet = mutation.target.closest?.('article[data-testid="tweet"]');
            if (tweet) queueTweets(tweet);
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1 || node.matches('.' + BUTTON_CLASS + ', #' + OVERLAY_ID)) continue;
                queueTweets(node);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    // ==========================================================
    // 初始化执行
    // ==========================================================
    injectStyle();
    const scheduleSearchLayout = initSearchLayout();
    initWidthControl(scheduleSearchLayout);
    queueTweets(document);
    console.log(`[X轮播展开] v${VERSION} 已启动 (支持格式选择/压缩调节/体积预估)`);
})();
