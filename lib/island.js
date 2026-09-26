// ──────────────────────────────────────────────
// 灵动岛：one pill at the top of the Claude Max panel that morphs between states
// ──────────────────────────────────────────────
//
// idle (a dot: proxy up / down) → thinking (elapsed seconds) → writing
// (live character count) → done (check, length, cache) → back to the dot.
// Notices (reply restored, check-up issues, proxy lost) use the same shape.
//
// Motion: size and radius ride a critically-damped-ish spring baked into a
// CSS linear() easing; content swaps with a short blur. Nothing loops except
// the small pulse while a reply is being generated, so the page is idle the
// rest of the time. Honours prefers-reduced-motion.

/** Damped spring step response 0 → 1, sampled into CSS linear() points. */
export function springCurve({ stiffness = 380, damping = 30, mass = 1, points = 32 } = {}) {
    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const x = (t) => {
        if (zeta < 1) {
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
        }
        return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    };
    // Settle: last time the curve is further than 0.2% from rest.
    let settle = 0;
    for (let t = 0; t < 3; t += 0.004) if (Math.abs(1 - x(t)) > 0.002) settle = t;
    settle = Math.max(settle, 0.12);
    const values = [];
    for (let i = 0; i <= points; i++) values.push(i === points ? 1 : x((settle * i) / points));
    return { duration: Math.round(settle * 1000), values, overshoot: Math.max(...values) - 1 };
}

export function linearEasing(values) {
    return `linear(${values.map((v) => Number(v.toFixed(4))).join(', ')})`;
}

const MORPH = springCurve({ stiffness: 420, damping: 32 });   // ~2% overshoot: "a tiny overshoot at most"

/**
 * createIsland(doc) → { mount(el), visible, set(state), notice(n), clear(key) }
 * state: { kind: 'idle'|'thinking'|'writing'|'done', online, chars, startedAt, cache, seconds }
 * notice: { tone: 'ok'|'info'|'warn'|'bad', title, text, ms (0 = until dismissed), onDismiss }
 */
export function createIsland(doc = document) {
    const win = doc.defaultView;
    const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const hasLinear = win.CSS?.supports?.('transition-timing-function', 'linear(0, 1)');
    const ease = hasLinear ? linearEasing(MORPH.values) : 'cubic-bezier(.2,.9,.3,1.04)';
    const dur = hasLinear ? MORPH.duration : 420;

    const root = doc.createElement('div');
    root.className = 'cm-island';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    const body = doc.createElement('div');
    body.className = 'cm-island-body';
    root.append(body);

    let state = { kind: 'idle', online: null };
    const queue = [];
    let current = null;       // notice being shown
    let timer = null;
    let ticker = null;

    function node(tag, cls, text) {
        const n = doc.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function contentFor() {
        if (current) {
            const c = node('div', `cm-isl-content cm-isl-notice cm-isl-${current.tone ?? 'info'}`);
            c.append(node('i', `cm-isl-icon fa-solid ${ICON[current.tone ?? 'info']}`));
            const t = node('div', 'cm-isl-text');
            t.append(node('b', null, current.title));
            if (current.text) t.append(node('small', null, current.text));
            c.append(t);
            return { el: c, key: `n:${current.id}`, shape: 'card' };
        }
        const s = state;
        if (s.kind === 'thinking' || s.kind === 'writing') {
            const c = node('div', 'cm-isl-content cm-isl-live');
            c.append(node('span', 'cm-isl-pulse'));
            const secs = Math.max(0, Math.round((Date.now() - (s.startedAt ?? Date.now())) / 1000));
            c.append(node('span', 'cm-isl-label', s.kind === 'thinking' ? '思考中' : '写作中'));
            c.append(node('span', 'cm-isl-num', s.kind === 'writing' ? `${(s.chars ?? 0).toLocaleString('zh-CN')} 字` : `${secs}s`));
            return { el: c, key: s.kind, shape: 'pill' };
        }
        if (s.kind === 'done') {
            const c = node('div', 'cm-isl-content cm-isl-done');
            c.append(node('i', 'cm-isl-icon fa-solid fa-check'));
            const bits = [];
            if (s.chars) bits.push(`${s.chars.toLocaleString('zh-CN')} 字`);
            if (s.seconds != null) bits.push(`${s.seconds}s`);
            if (s.cache != null) bits.push(`缓存 ${s.cache}%`);
            c.append(node('span', 'cm-isl-label', bits.join(' · ') || '完成'));
            return { el: c, key: `done:${bits.join()}`, shape: 'pill' };
        }
        return { el: node('div', 'cm-isl-content cm-isl-dot'), key: `idle:${s.online}`, shape: 'dot' };
    }

    let shownKey = '';
    function render() {
        const { el, key, shape } = contentFor();
        root.dataset.shape = shape;
        root.dataset.online = String(state.online);
        root.classList.toggle('cm-isl-tappable', !!current);
        if (key === shownKey) return;
        const sameKind = shownKey.split(':')[0] === key.split(':')[0] && shape !== 'card';
        shownKey = key;
        const old = body.firstElementChild;
        const from = root.getBoundingClientRect();
        body.replaceChildren(el);
        if (reduce || !old || !win.Element.prototype.animate) return;
        const to = root.getBoundingClientRect();
        if (sameKind) return; // a number ticking over: no morph, no blur
        // Size and radius spring from the old shape; content crossfades with a blur.
        root.animate([
            { width: `${from.width}px`, height: `${from.height}px` },
            { width: `${to.width}px`, height: `${to.height}px` },
        ], { duration: dur, easing: ease });
        const ghost = old.cloneNode(true);
        ghost.classList.add('cm-isl-ghost');
        body.append(ghost);
        ghost.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(4px)' }], { duration: 140, easing: 'ease-out', fill: 'forwards' })
            .finished.then(() => ghost.remove(), () => ghost.remove());
        el.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 220, delay: 70, easing: 'ease-out', fill: 'backwards' });
    }

    function tick() {
        clearInterval(ticker);
        ticker = state.kind === 'thinking' && !current ? setInterval(() => { shownKey = ''; renderQuiet(); }, 1000) : null;
    }
    // Update numbers in place (no morph) while the kind stays the same.
    function renderQuiet() {
        const { el, key } = contentFor();
        shownKey = key;
        body.replaceChildren(el);
    }

    function next() {
        clearTimeout(timer);
        current = queue.shift() ?? null;
        render();
        tick();
        if (current?.ms) timer = setTimeout(() => dismiss(false), current.ms);
    }

    function dismiss(byUser = true) {
        if (!current) return;
        const n = current;
        current = null;
        if (byUser) n.onDismiss?.();
        next();
    }

    root.addEventListener('click', () => dismiss(true));

    let seq = 0;
    return {
        root,
        /** Put the pill into (or back into, after the panel was rebuilt) a container. */
        mount(el) {
            if (!el || root.parentElement === el) return;
            el.append(root);
            shownKey = '';
            render();
        },
        /** Is it on screen right now (panel open, page visible)? */
        get visible() { return root.isConnected && root.offsetParent !== null && !doc.hidden; },
        set(patch) {
            const kindChanged = patch.kind && patch.kind !== state.kind;
            state = { ...state, ...patch };
            if (current) return;
            if (!kindChanged && state.kind === 'writing') return renderQuiet();
            render();
            tick();
        },
        notice(n) {
            const item = { ms: 6000, ...n, id: ++seq };
            if (n.replace) {
                for (let i = queue.length - 1; i >= 0; i--) if (queue[i].replace === n.replace) queue.splice(i, 1);
                if (current?.replace === n.replace) { current = item; shownKey = ''; clearTimeout(timer); render(); if (item.ms) timer = setTimeout(() => dismiss(false), item.ms); return item.id; }
            }
            queue.push(item);
            if (!current) next();
            return item.id;
        },
        clear(replaceKey) {
            for (let i = queue.length - 1; i >= 0; i--) if (queue[i].replace === replaceKey) queue.splice(i, 1);
            if (current?.replace === replaceKey) dismiss(false);
        },
        get state() { return state; },
    };
}

const ICON = { ok: 'fa-check', info: 'fa-circle-info', warn: 'fa-triangle-exclamation', bad: 'fa-circle-exclamation' };
