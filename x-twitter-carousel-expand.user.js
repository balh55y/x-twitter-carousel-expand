// ==UserScript==
// @name         X / Twitter 轮播图展开 (画质与体积优化版)
// @namespace    https://github.com/balh55y/x-twitter-carousel-expand
// @version      6.5.0
// @description  选择 X 帖子图片，支持智能排版、横向、纵向和网格，复制和下载时可设置画质与尺寸
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

    const VERSION = '6.5.0';

    const BUTTON_CLASS = '__x_carousel_expand_v6__';
    const OVERLAY_ID = '__x_carousel_overlay_v6__';
    const STYLE_ID = '__x_carousel_style_v6__';
    const WIDTH_BUTTON_ID = '__x_carousel_width_v6__';
    const IMAGE_LAYOUTS = [
        { id: 'horizontal', label: '横向' },
        { id: 'vertical', label: '纵向' },
        { id: 'grid-2', label: '两列' },
        { id: 'grid-3', label: '三列' },
        { id: 'justified', label: '智能排版' }
    ];
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
        CONTENT_WIDTH: '__x_carousel_content_width_v6__',
        LAYOUT: '__x_carousel_layout_v6__'
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
        const layout = readSetting(STORAGE_KEYS.LAYOUT);
        return {
            format: ['image/jpeg', 'image/png', 'image/webp'].includes(format) ? format : 'image/jpeg',
            quality: Number.isFinite(quality) ? Math.min(1, Math.max(0.3, quality)) : 0.85,
            scaleMode: ['1', '0.75', '0.5', '0.25', 'max-1440', 'max-1080'].includes(scaleMode) ? scaleMode : '1',
            layout: IMAGE_LAYOUTS.some(item => item.id === layout) ? layout : 'horizontal'
        };
    }

    function saveStoredSettings(settings) {
        if (settings.format) writeSetting(STORAGE_KEYS.FORMAT, settings.format);
        if (Number.isFinite(settings.quality)) writeSetting(STORAGE_KEYS.QUALITY, settings.quality);
        if (settings.scaleMode) writeSetting(STORAGE_KEYS.SCALE, settings.scaleMode);
        if (IMAGE_LAYOUTS.some(item => item.id === settings.layout)) writeSetting(STORAGE_KEYS.LAYOUT, settings.layout);
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

            #${OVERLAY_ID} .x-expand-toolbar {
                max-block-size: 45dvh !important;
                overflow: auto !important;
                overscroll-behavior: contain !important;
            }
            #${OVERLAY_ID} .x-selection-group,
            #${OVERLAY_ID} .x-layout-group {
                min-inline-size: 0;
                margin: 0;
                padding: 0;
                border: 0;
            }
            #${OVERLAY_ID} .x-selection-group { flex: 1 0 100%; }
            #${OVERLAY_ID} legend { padding: 0 0 6px; font-size: 13px; color: #535b62; }
            #${OVERLAY_ID} .x-selection-row,
            #${OVERLAY_ID} .x-layout-options { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
            #${OVERLAY_ID} .x-selection-choice { position: relative; display: inline-flex; flex: 0 0 auto; }
            #${OVERLAY_ID} .x-selection-check {
                appearance: none;
                inline-size: 44px;
                block-size: 44px;
                margin: 0;
                border: 1px solid #858b91;
                border-radius: 4px;
                background: #fff;
                cursor: pointer;
            }
            #${OVERLAY_ID} .x-selection-check:checked { border-color: #32729b; background: #eaf3fa; }
            #${OVERLAY_ID} .x-selection-choice label {
                position: absolute; inset: 0; display: grid; place-content: center;
                color: #30373d; font-size: 13px; font-variant-numeric: tabular-nums;
                cursor: pointer; pointer-events: none;
            }
            #${OVERLAY_ID} .x-selection-choice label::after {
                content: '✓'; position: absolute; inset-block-start: 1px; inset-inline-end: 3px;
                font-size: 10px; visibility: hidden;
            }
            #${OVERLAY_ID} .x-selection-check:checked + label::after { visibility: visible; }
            #${OVERLAY_ID} .x-selection-row > button {
                min-block-size: 36px; padding: 6px 10px; border: 1px solid #858b91;
                border-radius: 4px; background: #fff; color: #30373d; cursor: pointer; font: inherit;
            }
            #${OVERLAY_ID} .x-selection-summary { color: #535b62; font-size: 13px; margin-inline-start: 6px; }
            #${OVERLAY_ID} .x-layout-choice { display: inline-flex; align-items: center; min-block-size: 44px; gap: 4px; padding-inline-end: 8px; }
            #${OVERLAY_ID} .x-layout-choice input { accent-color: #32729b; }
            #${OVERLAY_ID} .x-layout-choice label { cursor: pointer; font-size: 13px; }
            #${OVERLAY_ID} .x-preview-stage { position: relative; margin-inline: auto; background: #fff; }
            #${OVERLAY_ID} .x-preview-stage .x-preview-item { position: absolute; }
            #${OVERLAY_ID} .x-preview-item {
                display: block; margin: 0; padding: 0; border: 0; background: #fff; color: #30373d;
                box-sizing: border-box; cursor: pointer; isolation: isolate;
            }
            #${OVERLAY_ID} .x-preview-item[aria-pressed="true"]::after {
                content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 1;
                border: 1px solid #5b9bc5;
                box-shadow: inset 0 0 0 1px rgba(255,255,255,.75), 0 0 4px rgba(80,145,190,.32);
            }
            #${OVERLAY_ID} .x-preview-item img { display: block; inline-size: 100%; block-size: 100%; object-fit: contain; }
            #${OVERLAY_ID} .x-preview-number {
                position: absolute; inset-block-start: 5px; inset-inline-start: 5px;
                background: #fff; color: #30373d; border: 1px solid #858b91; border-radius: 3px;
                padding: 1px 5px; font-size: 12px; pointer-events: none; z-index: 2;
            }
            #${OVERLAY_ID} .x-preview-empty { margin: 32px 0; color: #535b62; text-align: center; }
            #${OVERLAY_ID} .x-unselected { margin-block-start: 24px; }
            #${OVERLAY_ID} .x-unselected h3 { font: 500 13px/1.5 system-ui, sans-serif; color: #535b62; margin: 0 0 10px; }
            #${OVERLAY_ID} .x-unselected-images { display: flex; flex-wrap: wrap; gap: 10px; }
            #${OVERLAY_ID} .x-unselected .x-preview-item { inline-size: 110px; block-size: 110px; border: 1px solid #a1a7ad; }
            #${OVERLAY_ID} .x-selection-check:disabled,
            #${OVERLAY_ID} .x-layout-choice input:disabled,
            #${OVERLAY_ID} .x-selection-row > button:disabled { opacity: .5; cursor: default; }
            #${OVERLAY_ID} [hidden] { display: none !important; }
            @media (forced-colors: active) {
                #${OVERLAY_ID} .x-selection-check { border-color: ButtonText; background: Canvas; }
                #${OVERLAY_ID} .x-selection-check:checked { border: 2px solid Highlight; }
                #${OVERLAY_ID} .x-preview-item[aria-pressed="true"]::after { border-color: Highlight; box-shadow: none; }
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
        const sources = [];
        const sizes = [];
        for (let i = 0; i < urls.length; i++) {
            onProgress?.(`正在下载原图（${i + 1}/${urls.length}）`);
            const blob = await gmRequest(urls[i]);
            const bitmap = await blobToBitmap(blob);
            try {
                sizes.push({ width: bitmap.width, height: bitmap.height });
                sources.push(blob);
            } finally {
                releaseBitmaps([bitmap]);
            }
        }
        return { sources, sizes };
    }

    function planJustifiedLayout(sizes) {
        if (sizes.length === 1) {
            return { ...sizes[0], placements: [{ x: 0, y: 0, ...sizes[0] }] };
        }
        // Use the typical source width so one panorama cannot enlarge the whole collage.
        const widths = sizes.map(size => size.width).sort((a, b) => a - b);
        const middle = Math.floor(widths.length / 2);
        const medianWidth = widths.length % 2 ? widths[middle] : (widths[middle - 1] + widths[middle]) / 2;
        const width = Math.max(1, Math.round(medianWidth * 2));
        const targetHeight = width / 2;
        const ratios = sizes.map(size => size.width / size.height);
        const costs = Array(sizes.length + 1).fill(Infinity);
        const breaks = [];
        costs[sizes.length] = 0;
        // Score complete partitions so the last row can share images with earlier rows.
        for (let start = sizes.length - 1; start >= 0; start--) {
            let ratioSum = 0;
            for (let end = start + 1; end <= sizes.length; end++) {
                ratioSum += ratios[end - 1];
                const height = width / ratioSum;
                const cost = (end - start) * (height / targetHeight - 1) ** 2 + costs[end];
                if (cost < costs[start]) {
                    costs[start] = cost;
                    breaks[start] = end;
                }
            }
        }
        const placements = [];
        let y = 0;
        for (let start = 0; start < sizes.length;) {
            const end = breaks[start];
            const ratioSum = ratios.slice(start, end).reduce((sum, ratio) => sum + ratio, 0);
            const height = width / ratioSum;
            let x = 0;
            for (let index = start; index < end; index++) {
                const right = index === end - 1 ? width : x + height * ratios[index];
                placements.push({ x, y, width: right - x, height });
                x = right;
            }
            y += height;
            start = end;
        }
        return { width, height: y, placements };
    }

    // 预览和导出共用同一组坐标，保留原图比例和帖子顺序。
    function planImageLayout(sizes, layout = 'horizontal') {
        if (!sizes.length) throw new Error('请至少选择 1 张图片');
        if (sizes.some(size => !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0)) {
            throw new Error('无法读取图片尺寸，请重新打开预览');
        }
        if (layout === 'justified') return planJustifiedLayout(sizes);
        const placements = [];
        if (layout === 'horizontal' || layout === 'vertical') {
            let offset = 0;
            let cross = 0;
            for (const size of sizes) {
                const horizontal = layout === 'horizontal';
                placements.push({ x: horizontal ? offset : 0, y: horizontal ? 0 : offset, width: size.width, height: size.height });
                offset += horizontal ? size.width : size.height;
                cross = Math.max(cross, horizontal ? size.height : size.width);
            }
            return { width: layout === 'horizontal' ? offset : cross, height: layout === 'horizontal' ? cross : offset, placements };
        }
        const columns = Math.min(layout === 'grid-3' ? 3 : 2, sizes.length);
        const cellWidth = Math.max(...sizes.map(size => size.width));
        let y = 0;
        for (let start = 0; start < sizes.length; start += columns) {
            const row = sizes.slice(start, start + columns);
            const rowHeight = Math.max(...row.map(size => size.height));
            row.forEach((size, column) => placements.push({
                x: column * cellWidth + (cellWidth - size.width) / 2,
                y, width: size.width, height: size.height
            }));
            y += rowHeight;
        }
        return { width: cellWidth * columns, height: y, placements };
    }

    function scaleImageLayout(plan, scaleMode = '1') {
        const scale = scaleMode === 'max-1440' ? Math.min(1, 1440 / plan.height)
            : scaleMode === 'max-1080' ? Math.min(1, 1080 / plan.height)
            : Number.parseFloat(scaleMode) || 1;
        return {
            width: Math.max(1, Math.round(plan.width * scale)),
            height: Math.max(1, Math.round(plan.height * scale)),
            scale,
            placements: plan.placements.map(item => {
                const x = Math.round(item.x * scale);
                const y = Math.round(item.y * scale);
                return { x, y, width: Math.round((item.x + item.width) * scale) - x, height: Math.round((item.y + item.height) * scale) - y };
            })
        };
    }

    function getExportSizeError(plan, format) {
        // Chromium can encode an oversized WebP without reporting that it cropped the image.
        if (format === 'image/webp' && (plan.width > 16383 || plan.height > 16383)) {
            return `WebP 图片尺寸为 ${plan.width}×${plan.height}，单边上限 16383 px。请降低尺寸或改用 JPEG/PNG`;
        }
        if (plan.width > 32767 || plan.height > 32767 || plan.width * plan.height > 64000000) {
            return `图片尺寸为 ${plan.width}×${plan.height}，请减少选择或降低尺寸`;
        }
        return '';
    }

    function selectedImageUrls(images, selected) {
        return images.filter((_, index) => selected.has(index));
    }

    // 失败和成功路径都释放已解码图片；只下载本次选中的图片。
    async function combineImages(urls, options, onProgress) {
        if (!urls.length) throw new Error('请至少选择 1 张图片');
        const { format, quality, scaleMode, layout = 'horizontal' } = options;
        const { sources, sizes } = await loadAllImages(urls, onProgress);
        let canvas;
        try {
            const plan = scaleImageLayout(planImageLayout(sizes, layout), scaleMode);
            const sizeError = getExportSizeError(plan, format);
            if (sizeError) throw new Error(sizeError);
            canvas = document.createElement('canvas');
            canvas.width = plan.width;
            canvas.height = plan.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('无法创建画布，请降低尺寸后重试');
            ctx.imageSmoothingEnabled = layout === 'justified' || plan.scale < 1;
            if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
            if (format === 'image/jpeg') {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, plan.width, plan.height);
            }
            let deadline = performance.now() + 8;
            for (let index = 0; index < sources.length; index++) {
                const item = plan.placements[index];
                const bitmap = await blobToBitmap(sources[index]);
                try {
                    ctx.drawImage(bitmap, item.x, item.y, item.width, item.height);
                } finally {
                    releaseBitmaps([bitmap]);
                    sources[index] = null;
                }
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
            // Release the full canvas before decoding the file for an independent size check.
            canvas.width = 1; canvas.height = 1;
            onProgress?.('正在检查导出图片');
            let encoded;
            try {
                encoded = await blobToBitmap(blob);
            } catch {
                throw new Error('无法检查导出图片，请降低尺寸或更换格式后重试');
            }
            try {
                if (encoded.width !== plan.width || encoded.height !== plan.height) {
                    throw new Error(`导出图片尺寸不完整（${encoded.width}×${encoded.height}，应为 ${plan.width}×${plan.height}），请降低尺寸或更换格式后重试`);
                }
            } finally {
                releaseBitmaps([encoded]);
            }
            return { blob, width: plan.width, height: plan.height, size: blob.size, format: blob.type || format };
        } finally {
            sources.length = 0;
            if (canvas) { canvas.width = 1; canvas.height = 1; }
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
        statusEl._updateControls?.();
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
        if (copyBtn.disabled || statusEl._exporting || !urls.length) return;
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
                copyBtn.textContent = '复制所选';
                hideStatus(statusEl, 2800);
            }, 1800);

        } catch (error) {
            console.error('[X轮播展开] 复制失败:', error);
            copyBtn.textContent = '复制所选';
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
        if (downloadBtn.disabled || statusEl._exporting || !urls.length) return;
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
                downloadBtn.textContent = '下载所选';
                hideStatus(statusEl, 2500);
            }, 1800);

        } catch (error) {
            console.error('[X轮播展开] 下载失败:', error);
            downloadBtn.textContent = '下载所选';
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
        const selected = new Set(images.slice(0, 4).map((_, index) => index));
        const overlay = document.createElement('dialog');
        overlay.id = OVERLAY_ID;
        overlay.lang = 'zh-CN';
        overlay.setAttribute('aria-labelledby', `${OVERLAY_ID}_title`);
        overlay.setAttribute('closedby', 'any');
        let renderFrame = null;

        const toolbar = document.createElement('div');
        toolbar.className = 'x-expand-toolbar';
        const leftBox = document.createElement('div');
        leftBox.className = 'x-toolbar-left';
        const title = document.createElement('h2');
        title.id = `${OVERLAY_ID}_title`;
        title.className = 'x-expand-title';
        title.textContent = '图片预览';
        const count = document.createElement('span');
        count.className = 'x-image-count';
        count.textContent = `${images.length} 张`;
        leftBox.append(title, count);
        const settingsBox = document.createElement('div');
        settingsBox.className = 'x-toolbar-settings';

        function makeSelect(id, text, options, value) {
            const group = document.createElement('div');
            group.className = 'x-ctrl-group';
            const label = document.createElement('label');
            label.htmlFor = id;
            label.textContent = text;
            const select = document.createElement('select');
            select.id = id;
            select.className = 'x-select';
            for (const [key, name] of options) {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = name;
                select.append(option);
            }
            select.value = value;
            group.append(label, select);
            settingsBox.append(group);
            return select;
        }
        const fmtSelect = makeSelect('x-format-select', '格式：', [['image/jpeg', 'JPEG'], ['image/png', 'PNG'], ['image/webp', 'WebP']], stored.format);
        const qualityGroup = document.createElement('div');
        qualityGroup.className = 'x-ctrl-group';
        const qualityName = document.createElement('label');
        qualityName.htmlFor = 'x-quality-slider';
        qualityName.textContent = '质量：';
        const qualitySlider = document.createElement('input');
        qualitySlider.type = 'range';
        qualitySlider.id = 'x-quality-slider';
        qualitySlider.className = 'x-slider';
        qualitySlider.min = '30';
        qualitySlider.max = '100';
        qualitySlider.step = '5';
        qualitySlider.value = String(Math.round(stored.quality * 100));
        const qualityLabel = document.createElement('span');
        qualityLabel.className = 'x-quality-val';
        qualityGroup.append(qualityName, qualitySlider, qualityLabel);
        settingsBox.append(qualityGroup);
        const scaleSelect = makeSelect('x-scale-select', '尺寸：', [
            ['1', '100%（原图）'], ['0.75', '75%'], ['0.5', '50%'], ['0.25', '25%'],
            ['max-1440', '限高 1440 px'], ['max-1080', '限高 1080 px']
        ], stored.scaleMode);

        const layoutGroup = document.createElement('fieldset');
        layoutGroup.className = 'x-layout-group';
        const layoutLegend = document.createElement('legend');
        layoutLegend.textContent = '排版';
        const layoutOptions = document.createElement('div');
        layoutOptions.className = 'x-layout-options';
        const layoutInputs = IMAGE_LAYOUTS.map(mode => {
            const choice = document.createElement('div');
            choice.className = 'x-layout-choice';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'x-image-layout';
            input.id = `x-layout-${mode.id}`;
            input.value = mode.id;
            input.checked = mode.id === stored.layout;
            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = mode.label;
            choice.append(input, label);
            layoutOptions.append(choice);
            return input;
        });
        layoutGroup.append(layoutLegend, layoutOptions);
        settingsBox.append(layoutGroup);
        const sizeBadge = document.createElement('div');
        sizeBadge.className = 'x-size-badge';
        settingsBox.append(sizeBadge);

        function makeButton(text, className) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.className = className;
            return button;
        }
        const actions = document.createElement('div');
        actions.className = 'x-expand-actions';
        const copyButton = makeButton('复制所选', 'x-copy-button');
        const downloadButton = makeButton('下载所选', 'x-download-button');
        const closeButton = makeButton('关闭', 'x-expand-close');
        closeButton.autofocus = true;
        actions.append(copyButton, downloadButton, closeButton);
        toolbar.append(leftBox, settingsBox, actions);

        const selectionGroup = document.createElement('fieldset');
        selectionGroup.className = 'x-selection-group';
        const legend = document.createElement('legend');
        legend.textContent = '选择图片';
        const selectionRow = document.createElement('div');
        selectionRow.className = 'x-selection-row';
        const checks = images.map((_, index) => {
            const choice = document.createElement('div');
            choice.className = 'x-selection-choice';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'x-selection-check';
            input.id = `x-image-select-${index}`;
            input.checked = selected.has(index);
            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = String(index + 1);
            input.addEventListener('change', () => toggleSelection(index, input.checked));
            choice.append(input, label);
            selectionRow.append(choice);
            return input;
        });
        const selectAll = makeButton('全选', 'x-select-all');
        const clearAll = makeButton('清空', 'x-clear-all');
        const summary = document.createElement('span');
        summary.className = 'x-selection-summary';
        selectionRow.append(selectAll, clearAll, summary);
        selectionGroup.append(legend, selectionRow);
        toolbar.append(selectionGroup);

        const viewport = document.createElement('div');
        viewport.className = 'x-expand-viewport';
        const stage = document.createElement('div');
        stage.className = 'x-preview-stage';
        const empty = document.createElement('p');
        empty.className = 'x-preview-empty';
        empty.textContent = '选择图片后可复制或下载';
        const unused = document.createElement('section');
        unused.className = 'x-unselected';
        const unusedTitle = document.createElement('h3');
        unusedTitle.textContent = '未选图片';
        const unusedImages = document.createElement('div');
        unusedImages.className = 'x-unselected-images';
        unused.append(unusedTitle, unusedImages);
        viewport.append(stage, empty, unused);

        const entries = images.map((url, index) => {
            const button = makeButton('', 'x-preview-item');
            button.dataset.index = String(index);
            button.setAttribute('aria-label', `图片 ${index + 1}`);
            const img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            img.loading = selected.has(index) ? 'eager' : 'lazy';
            img.addEventListener('load', scheduleRender);
            img.addEventListener('error', scheduleRender);
            img.src = url;
            const number = document.createElement('span');
            number.className = 'x-preview-number';
            number.setAttribute('aria-hidden', 'true');
            number.textContent = String(index + 1);
            button.append(img, number);
            button.addEventListener('click', () => toggleSelection(index, !selected.has(index)));
            return { button, img };
        });

        const status = document.createElement('div');
        status.className = 'x-copy-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'off');
        const progress = document.createElement('progress');
        progress.className = 'x-export-progress';
        progress.setAttribute('aria-label', '生成图片');
        progress.hidden = true;
        status._progress = progress;
        status._updateControls = updateControls;
        toolbar.append(progress);
        overlay.append(toolbar, viewport, status);
        document.body.append(overlay);
        overlay.showModal();

        function getCurrentOptions() {
            return { format: fmtSelect.value, quality: Number(qualitySlider.value) / 100,
                scaleMode: scaleSelect.value, layout: layoutInputs.find(input => input.checked).value };
        }
        function updateControls() {
            const busy = Boolean(status._exporting);
            copyButton.disabled = downloadButton.disabled = busy || !selected.size;
            selectionGroup.disabled = layoutGroup.disabled = busy;
            fmtSelect.disabled = scaleSelect.disabled = busy;
            qualitySlider.disabled = busy || fmtSelect.value === 'image/png';
            selectAll.disabled = busy || selected.size === images.length;
            clearAll.disabled = busy || !selected.size;
            entries.forEach(entry => { entry.button.disabled = busy; });
        }
        function toggleSelection(index, checked) {
            if (status._exporting) return;
            if (checked) selected.add(index); else selected.delete(index);
            checks[index].checked = checked;
            if (checked) entries[index].img.loading = 'eager';
            render();
        }
        function scheduleRender() {
            if (!overlay.isConnected || renderFrame !== null) return;
            renderFrame = requestAnimationFrame(() => { renderFrame = null; render(); });
        }
        function render() {
            if (!overlay.isConnected) return;
            const options = getCurrentOptions();
            scaleSelect.options[0].textContent = options.layout === 'justified' ? '100%（排版尺寸）' : '100%（原图）';
            const indexes = images.map((_, index) => index).filter(index => selected.has(index));
            summary.textContent = `已选 ${indexes.length} / ${images.length} 张`;
            qualityLabel.textContent = options.format === 'image/png' ? '无损' : `${Math.round(options.quality * 100)}%`;
            empty.hidden = indexes.length > 0;
            stage.hidden = !indexes.length;
            unused.hidden = indexes.length === images.length;
            const active = document.activeElement;
            let selectedPosition = 0;
            let unusedPosition = 0;
            entries.forEach((entry, index) => {
                const chosen = selected.has(index);
                entry.button.setAttribute('aria-pressed', String(chosen));
                entry.button.setAttribute('aria-description', chosen ? '已选；点击取消' : '未选；点击加入');
                const parent = chosen ? stage : unusedImages;
                const position = chosen ? selectedPosition++ : unusedPosition++;
                if (!chosen) entry.button.removeAttribute('style');
                const sibling = parent.children[position] || null;
                if (sibling !== entry.button) parent.insertBefore(entry.button, sibling);
            });
            if (active?.classList.contains('x-preview-item') && active.isConnected) active.focus({ preventScroll: true });
            updateControls();
            if (!indexes.length) { sizeBadge.textContent = '未选择图片'; stage.style.width = stage.style.height = '0px'; return; }
            const sizes = indexes.map(index => ({ width: entries[index].img.naturalWidth || 1000, height: entries[index].img.naturalHeight || 1000 }));
            const plan = planImageLayout(sizes, options.layout);
            const usableWidth = Math.max(1, viewport.clientWidth - (innerWidth < 720 ? 24 : 48));
            const usableHeight = Math.max(160, viewport.clientHeight - 48);
            const scale = options.layout === 'horizontal'
                ? Math.min(1, usableHeight / plan.height)
                : Math.min(1, Math.min(usableWidth, 1200) / plan.width);
            stage.style.width = `${plan.width * scale}px`;
            stage.style.height = `${plan.height * scale}px`;
            plan.placements.forEach((item, offset) => {
                const style = entries[indexes[offset]].button.style;
                style.left = `${item.x * scale}px`; style.top = `${item.y * scale}px`;
                style.width = `${item.width * scale}px`; style.height = `${item.height * scale}px`;
            });
            if (indexes.some(index => !entries[index].img.naturalWidth)) {
                sizeBadge.textContent = '正在读取已选图片尺寸'; return;
            }
            const output = scaleImageLayout(plan, options.scaleMode);
            const factor = options.format === 'image/png' ? 1.35 : options.format === 'image/webp'
                ? 0.03 + 0.22 * Math.pow(options.quality, 2.5) : 0.04 + 0.30 * Math.pow(options.quality, 2.4);
            const bytes = output.width * output.height * factor;
            sizeBadge.textContent = `预估约 ${formatBytes(bytes)} · ${output.width}×${output.height}`;
            sizeBadge.className = 'x-size-badge';
            const sizeError = getExportSizeError(output, options.format);
            if (sizeError) {
                sizeBadge.textContent = sizeError;
                sizeBadge.classList.add('warning');
            }
            sizeBadge.title = sizeError || '文件大小为估算值，各平台的发送限制可能不同';
        }
        selectAll.addEventListener('click', () => {
            images.forEach((_, index) => { selected.add(index); checks[index].checked = true; entries[index].img.loading = 'eager'; });
            render();
        });
        clearAll.addEventListener('click', () => { selected.clear(); checks.forEach(input => { input.checked = false; }); render(); });
        for (const control of [fmtSelect, qualitySlider, scaleSelect, ...layoutInputs]) {
            control.addEventListener(control === qualitySlider ? 'input' : 'change', () => { saveStoredSettings(getCurrentOptions()); render(); });
        }
        copyButton.addEventListener('click', () => handleCopy(selectedImageUrls(images, selected), copyButton, status, getCurrentOptions));
        downloadButton.addEventListener('click', () => handleDownload(selectedImageUrls(images, selected), downloadButton, status, getCurrentOptions));
        closeButton.addEventListener('click', closeViewer);
        overlay.addEventListener('click', event => event.stopPropagation());
        if (!('closedBy' in HTMLDialogElement.prototype)) {
            const outside = event => {
                const rect = overlay.getBoundingClientRect();
                return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
            };
            let pressedOutside = false;
            overlay.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
            overlay.addEventListener('pointerup', event => { if (pressedOutside && outside(event)) overlay.close(); });
        }
        viewport.addEventListener('wheel', event => {
            if (getCurrentOptions().layout !== 'horizontal' || event.ctrlKey || event.shiftKey || event.deltaX || !event.deltaY ||
                viewport.scrollWidth <= viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight + 1) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
            const previous = viewport.scrollLeft;
            viewport.scrollLeft += event.deltaY * unit;
            if (viewport.scrollLeft !== previous) event.preventDefault();
        }, { passive: false });
        const resize = new ResizeObserver(scheduleRender);
        resize.observe(viewport);
        overlay.addEventListener('close', () => {
            resize.disconnect();
            if (renderFrame !== null) cancelAnimationFrame(renderFrame);
            overlay.remove();
        }, { once: true });
        render();
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
