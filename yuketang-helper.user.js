// ==UserScript==
// @name         雨课堂刷课助手 (ai-workspace)
// @namespace    yk-autoplayer
// @version      1.4.0
// @description  雨课堂视频辅助播放：倍速、静音、按视频目录切换，可选跳过已完成的视频
// @match        https://www.yuketang.cn/ai-workspace/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @icon         https://www.yuketang.cn/favicon.ico
// ==/UserScript==

(function () {
    'use strict';

    // 与该播放器当前提供的选项保持一致。
    const RATES = [1, 1.25, 1.5, 2];
    const RUN_KEY = 'ykauto-running-v1';
    const savedRate = Number(GM_getValue('rate', 2));
    const cfg = {
        rate: RATES.includes(savedRate) ? savedRate : 2,
        muted: !!GM_getValue('muted', true),
        // 新版本默认关闭；用户主动开启后才按页面的完成标记跳过。
        skipCompleted: !!GM_getValue('skipCompletedV2', false),
        debug: !!GM_getValue('debug', false),
    };
    const state = {
        running: readRunning(),
        video: null,
        pageKey: null,
        transition: null,
        handledEnd: false,
        playPending: false,
        playError: '',
        completedCount: 0,
        status: '未启动',
        panel: null,
        lastNativeRateAttempt: 0,
        nativeRateAttempts: 0,
        rateCheckTimer: null,
    };

    function readRunning() {
        try { return sessionStorage.getItem(RUN_KEY) === '1'; } catch (_) { return false; }
    }
    function saveRunning(value) {
        try { sessionStorage.setItem(RUN_KEY, value ? '1' : '0'); } catch (_) { /* 可继续使用当前页 */ }
    }
    function log(...args) { if (cfg.debug) console.log('[YKAuto]', ...args); }
    function isVideoPage() { return /\/ai-workspace\/.*\/video\//.test(location.pathname); }
    function pageKey() { return location.pathname + location.search; }
    function setStatus(text) {
        state.status = text;
        const el = state.panel && state.panel.querySelector('.yk-status');
        if (el) el.textContent = text;
    }
    function setRunning(value, message) {
        state.running = value;
        saveRunning(value);
        if (!value) state.transition = null;
        const btn = state.panel && state.panel.querySelector('.yk-main');
        if (btn) btn.textContent = value ? '暂停助手' : '开始播放';
        if (message) setStatus(message);
    }

    // 目录的当前视频由 is-active 标记；只点击紧随其后的“视频”条目。
    function videoItems() {
        return Array.from(document.querySelectorAll('.leaf-item')).filter(el => {
            const tag = el.querySelector('.leaf-item-tag');
            return tag && tag.textContent.trim() === '视频';
        });
    }
    function activeItem() {
        const active = videoItems().filter(el => el.classList.contains('is-active'));
        return active.length === 1 ? active[0] : null;
    }
    function isCompleted(item) {
        return !!item.querySelector('.leaf-item-status .icon-yuanquangou-mianzhuang');
    }
    function goNext(reason) {
        if (!state.running || state.transition) return;
        const items = videoItems();
        const active = activeItem();
        const index = items.indexOf(active);
        if (!active || index < 0) {
            setRunning(false, '无法确认当前视频，请手动选择下一视频后重新启动');
            return;
        }
        let next = null;
        for (let i = index + 1; i < items.length; i++) {
            if (!cfg.skipCompleted || !isCompleted(items[i])) { next = items[i]; break; }
        }
        if (!next) {
            setRunning(false, '目录中没有更多符合条件的视频，助手已停止');
            return;
        }
        const title = next.querySelector('.leaf-item-title')?.textContent.trim() || '下一视频';
        state.transition = { from: pageKey(), started: Date.now(), title };
        setStatus(`${reason}，正在切换：${title}`);
        log('切换视频', title);
        next.click();
    }

    function findVideo() {
        const docs = [document];
        for (let i = 0; i < docs.length && i < 20; i++) {
            const doc = docs[i];
            const videos = Array.from(doc.querySelectorAll('video'));
            const visible = videos.find(v => v.getBoundingClientRect().width > 0 && v.getBoundingClientRect().height > 0);
            if (visible) return visible;
            for (const frame of doc.querySelectorAll('iframe')) {
                try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) { /* 跨域不可读 */ }
            }
        }
        return null;
    }
    function applyPlaybackRate(video) {
        const options = Array.from(document.querySelectorAll('xt-speedbutton li[data-speed]'));
        const option = options.find(el => Number(el.getAttribute('data-speed')) === cfg.rate);
        const active = option && option.classList.contains('xt_video_player_common_active');
        // 直接改 video.playbackRate 会与播放器内部状态冲突，被它重置。
        // 优先调用播放器的选项，让内部状态与显示同步；限制重试频率。
        if (option && (!active || Math.abs(video.playbackRate - cfg.rate) > 0.01) &&
            state.nativeRateAttempts < 3 && Date.now() - state.lastNativeRateAttempt >= 3000) {
            state.lastNativeRateAttempt = Date.now();
            state.nativeRateAttempts++;
            // 播放器可能在鼠标进入倍速控件时才准备选项的事件处理。
            const wrap = option.closest('xt-speedbutton');
            if (wrap) {
                try {
                    // Tampermonkey 的 window 可能是代理对象，不能作为 MouseEvent 的 view。
                    wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
                } catch (e) { log('倍速控件鼠标事件失败，继续尝试点击', e); }
            }
            option.click();
        } else if (option && active && Math.abs(video.playbackRate - cfg.rate) <= 0.01) {
            state.nativeRateAttempts = 0;
        } else if (!options.length && Math.abs(video.playbackRate - cfg.rate) > 0.01) {
            // 非当前播放器时保留通用降级；不能保证平台接受。
            video.playbackRate = cfg.rate;
        }
        // 延迟采样，避免刚写入 2x 后立即显示成功，却在下一瞬间被重置。
        if (!state.rateCheckTimer) {
            state.rateCheckTimer = setTimeout(() => {
                state.rateCheckTimer = null;
                if (!state.running || state.video !== video || video.paused || video.ended || state.transition) return;
                const actual = Math.round(video.playbackRate * 100) / 100;
                setStatus(actual === cfg.rate ? `播放中 (${actual}x)` : `目标 ${cfg.rate}x，实际 ${actual}x；请在播放器菜单手动选择倍速`);
            }, 400);
        }
    }
    function tick() {
        if (!state.panel && isVideoPage() && document.body) buildPanel();
        if (!state.running) return;

        const key = pageKey();
        if (state.transition) {
            const active = activeItem();
            const activeTitle = active && active.querySelector('.leaf-item-title')?.textContent.trim();
            if (key !== state.transition.from && isVideoPage() && activeTitle === state.transition.title) {
                state.transition = null;
                state.pageKey = key;
                state.video = null;
                state.handledEnd = false;
                state.playError = '';
            } else if (Date.now() - state.transition.started > 10000) {
                setRunning(false, '切换未完成，请手动选择下一视频后重新启动');
                return;
            } else {
                return;
            }
        }
        if (!isVideoPage()) {
            setRunning(false, '已离开视频页面，助手已停止');
            return;
        }
        if (key !== state.pageKey) {
            state.pageKey = key;
            state.video = null;
            state.handledEnd = false;
            state.playError = '';
            state.nativeRateAttempts = 0;
            state.lastNativeRateAttempt = 0;
        }
        const active = activeItem();
        if (cfg.skipCompleted && active && isCompleted(active)) {
            goNext('当前视频显示已完成');
            return;
        }
        const video = findVideo();
        if (!video) { setStatus('未找到可见视频，等待播放器加载'); return; }
        if (video !== state.video) {
            state.video = video;
            state.handledEnd = false;
            state.playError = '';
            state.nativeRateAttempts = 0;
            state.lastNativeRateAttempt = 0;
        }
        if (video.ended) {
            if (!state.handledEnd) {
                state.handledEnd = true;
                state.completedCount++;
                goNext(`视频播放结束（本次 ${state.completedCount} 个）`);
            }
            return;
        }
        try {
            applyPlaybackRate(video);
            if (video.muted !== cfg.muted) video.muted = cfg.muted;
        } catch (e) { log('设置播放器失败', e); }
        if (video.paused && !state.playPending) {
            state.playPending = true;
            Promise.resolve(video.play()).then(() => { state.playError = ''; }).catch(e => {
                state.playError = e && e.name === 'NotAllowedError'
                    ? '浏览器阻止自动播放，请点击视频播放按钮'
                    : '自动播放失败，请检查播放器或手动播放';
                log('播放失败', e);
            }).finally(() => { state.playPending = false; });
        }
        if (state.playError && video.paused) setStatus(state.playError);
        else if (!video.paused) {
            const actual = Math.round(video.playbackRate * 100) / 100;
            setStatus(actual === cfg.rate ? `播放中 (${actual}x)` : `目标 ${cfg.rate}x，实际 ${actual}x`);
        } else setStatus('正在尝试播放…');
    }

    GM_addStyle(`
      #ykauto-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:rgba(30,30,34,.94);color:#eee;border-radius:10px;font:12px/1.7 system-ui,sans-serif;padding:10px 12px;width:230px;box-shadow:0 4px 16px #0005}
      #ykauto-panel .yk-head{font-weight:600;margin-bottom:4px}
      #ykauto-panel .yk-status{color:#8fd3ff;min-height:18px;overflow-wrap:anywhere}
      #ykauto-panel label{display:flex;align-items:center;gap:5px;cursor:pointer}
      #ykauto-panel select,#ykauto-panel button{background:#444;color:#eee;border:0;border-radius:5px;padding:2px 8px;font-size:12px;cursor:pointer}
      #ykauto-panel .yk-main{width:100%;margin-top:6px;padding:5px;background:#2f6fed;font-weight:600}
    `);
    function buildPanel() {
        if (document.getElementById('ykauto-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'ykauto-panel';
        panel.innerHTML = `
          <div class="yk-head">雨课堂刷课助手 1.4</div>
          <div class="yk-status"></div>
          <label>倍速 <select class="yk-rate">${RATES.map(r => `<option value="${r}" ${r === cfg.rate ? 'selected' : ''}>${r}x</option>`).join('')}</select></label>
          <label><input class="yk-mute" type="checkbox" ${cfg.muted ? 'checked' : ''}>自动静音</label>
          <label><input class="yk-skip" type="checkbox" ${cfg.skipCompleted ? 'checked' : ''}>跳过标记为已完成的视频</label>
          <label><input class="yk-debug" type="checkbox" ${cfg.debug ? 'checked' : ''}>调试日志</label>
          <button class="yk-main" type="button"></button>`;
        document.body.appendChild(panel);
        state.panel = panel;
        panel.querySelector('.yk-rate').addEventListener('change', e => { cfg.rate = Number(e.target.value); state.nativeRateAttempts = 0; state.lastNativeRateAttempt = 0; GM_setValue('rate', cfg.rate); });
        panel.querySelector('.yk-mute').addEventListener('change', e => { cfg.muted = e.target.checked; GM_setValue('muted', cfg.muted); });
        panel.querySelector('.yk-skip').addEventListener('change', e => { cfg.skipCompleted = e.target.checked; GM_setValue('skipCompletedV2', cfg.skipCompleted); });
        panel.querySelector('.yk-debug').addEventListener('change', e => { cfg.debug = e.target.checked; GM_setValue('debug', cfg.debug); });
        panel.querySelector('.yk-main').addEventListener('click', () => {
            if (state.running) setRunning(false, '助手已暂停；视频可用播放器控制');
            else {
                state.handledEnd = false;
                state.playError = '';
                setRunning(true, '正在启动…');
                tick();
            }
        });
        panel.querySelector('.yk-main').textContent = state.running ? '暂停助手' : '开始播放';
        setStatus(state.running ? '正在恢复播放…' : '未启动');
    }
    tick();
    setInterval(tick, 1000);
})();

