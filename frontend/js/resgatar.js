function getStorageType() {
    if (sessionStorage.getItem('cx_logged_in_user')) {
        return sessionStorage;
    }
    if (localStorage.getItem('cx_logged_in_user')) {
        return localStorage;
    }
    return window.CxSession?.getPrimaryStorage?.() || sessionStorage;
}

function getUsersData() {
    const storage = getStorageType();
    return JSON.parse(storage.getItem('cx_users') || '{}');
}

function getInitials(name) {
    if (!name) return 'EC';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function getPublicDisplayName(user, fallback = 'Agente EC') {
    return user?.display_name || user?.displayName || fallback;
}

function toggleMobileMenu() {
    const btn = document.getElementById('mobile-menu-btn');
    const nav = document.getElementById('mobile-nav');
    const overlay = document.getElementById('mobile-nav-overlay');
    if (!nav) return;
    const isOpen = nav.classList.contains('open');

    btn?.classList.toggle('active');
    nav.classList.toggle('open');
    overlay?.classList.toggle('visible');
    document.body.style.overflow = isOpen ? '' : 'hidden';
}

async function handleLogout() {
    document.body.style.opacity = '0';
    document.body.style.transition = 'opacity 0.4s ease';

    setTimeout(() => {
        window.CxSession?.clearSessionState?.();
        window.location.replace('login.html');
    }, 400);
}

function clearSkeleton(el) {
    if (!el) return;
    el.classList.remove('home-skeleton-text', 'home-skeleton-text--name',
        'home-skeleton-text--level', 'home-skeleton-text--xp');
}

function loadUserData() {
    const loggedInUser = window.CxSession?.getSessionValue?.('cx_logged_in_user')
        || localStorage.getItem('cx_logged_in_user')
        || sessionStorage.getItem('cx_logged_in_user');

    if (!loggedInUser) {
        window.CxSession?.redirectToLogin?.() || window.location.replace('login.html');
        return null;
    }

    const users = getUsersData();
    const user = users[loggedInUser];

    if (!user) {
        console.warn('[Resgatar] User not found in storage');
        window.CxSession?.redirectToLogin?.() || window.location.replace('login.html');
        return null;
    }

    const displayName = getPublicDisplayName(user);
    const initials = getInitials(displayName);
    const level = user.level || 1;
    const xp = Number(user.xp || 0);

    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = value; clearSkeleton(el); }
    };
    set('header-user-name', displayName);
    set('header-user-level', `Nível ${level}`);
    set('header-user-xp', `${xp} XP`);
    set('mobile-user-name', displayName);
    set('mobile-user-level', `Nível ${level}`);

    const updateAvatar = (container, isLarge = false) => {
        if (!container) return;

        if (user.avatar_file_name) {
            const avatarPath = `/frontend/assets/image/avatar/${user.avatar_file_name}`;
            const existingImg = container.querySelector('.user-avatar__img');
            if (existingImg && existingImg.getAttribute('src') === avatarPath) {
                // Image already matches, do not clear and recreate
                return;
            }

            container.innerHTML = '';

            const img = document.createElement('img');
            img.src = avatarPath;
            img.alt = displayName;
            img.className = 'user-avatar__img';
            img.onerror = () => { container.innerHTML = `<span class="user-avatar__initials">${initials}</span>`; };
            container.appendChild(img);
        } else {
            container.innerHTML = `<span class="user-avatar__initials">${initials}</span>`;
        }

        if (!isLarge) {
            const status = document.createElement('div');
            status.className = 'avatar-status';
            container.appendChild(status);
        }
    };
    updateAvatar(document.getElementById('header-user-avatar'), false);
    updateAvatar(document.getElementById('mobile-user-avatar'), true);

    return user;
}

const AML_SYMBOLS = {
    ec:     '<text x="14" y="19" font-family="DM Sans" font-weight="800" font-size="13" fill="currentColor" stroke="none" text-anchor="middle" class="aml-letters">EC</text>',
    xp:     '<text x="14" y="19" font-family="Space Mono" font-weight="700" font-size="12" fill="currentColor" stroke="none" text-anchor="middle">XP</text>',
    reward: '<rect x="6" y="12" width="16" height="10" rx="1.5" class="aml-draw" style="--len:52"/><line x1="6" y1="15.5" x2="22" y2="15.5" class="aml-draw" style="--len:16"/><line x1="14" y1="12" x2="14" y2="22" class="aml-draw" style="--len:10"/><path d="M14 12 C14 8 10 7.5 10 10 C10 12 14 12 14 12 Z" class="aml-draw" style="--len:14"/><path d="M14 12 C14 8 18 7.5 18 10 C18 12 14 12 14 12 Z" class="aml-draw" style="--len:14"/>',
    check:  '<polyline points="6,14.5 12,20 22,8" class="aml-draw" style="--len:26"/>'
};

const AML_SPARK = '<svg class="aml-spark" viewBox="0 0 28 28"><line x1="14" y1="1" x2="14" y2="4"/><line x1="14" y1="24" x2="14" y2="27"/><line x1="1" y1="14" x2="4" y2="14"/><line x1="24" y1="14" x2="27" y2="14"/><line x1="5" y1="5" x2="7" y2="7"/><line x1="21" y1="21" x2="23" y2="23"/><line x1="23" y1="5" x2="21" y2="7"/><line x1="7" y1="21" x2="5" y2="23"/></svg>';

const RESGATE_FLOW = ['ec', 'xp', 'reward', 'check'];

let _amlGen = 0;

function getRedeemApi() {
    return ((window.__APP_CONFIG__ && window.__APP_CONFIG__.CXGAME_VPS_API_BASE) || 'https://api.expconnect.com.br').replace(/\/+$/, '');
}

function rewardIcon(type) {
    if (type === 'xp') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/><path d="M12 11v6M9 14h6"/></svg>';
}

function formatRedeemDate(value) {
    if (!value) return 'Resgate registrado';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Resgate registrado';
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function redeemStatus(status) {
    const statuses = {
        concluido: ['Concluído', 'done'],
        pendente: ['Reservado', 'pending'],
        entregue: ['Entregue', 'delivered'],
        cancelado: ['Cancelado', 'cancelled']
    };
    return statuses[status] || ['Registrado', 'done'];
}

function renderRedeemHistory(payload) {
    const loading = document.getElementById('rd-history-loading');
    const list = document.getElementById('rd-history-list');
    const empty = document.getElementById('rd-history-empty');
    const total = document.getElementById('redeem-history-total');
    if (!loading || !list || !empty) return;

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const count = Number.isFinite(Number(payload?.total)) ? Number(payload.total) : items.length;
    loading.hidden = true;
    list.replaceChildren();
    if (total) total.textContent = String(count);

    if (!items.length) {
        list.hidden = true;
        empty.hidden = false;
        return;
    }

    empty.hidden = true;
    list.hidden = false;
    items.forEach((item) => {
        const type = item.reward_type === 'xp' ? 'xp' : 'brinde';
        const reward = item.reward && typeof item.reward === 'object' ? item.reward : {};
        const xp = Number(reward.xp);
        const title = type === 'xp'
            ? `+${Number.isFinite(xp) && xp > 0 ? xp : 0} XP`
            : (String(reward.nome || 'Brinde reservado').trim() || 'Brinde reservado');
        const [statusLabel, statusClass] = redeemStatus(item.status);

        const row = document.createElement('li');
        row.className = 'rd-redeem-item';
        const icon = document.createElement('span');
        icon.className = 'rd-redeem-item__icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = rewardIcon(type);

        const copy = document.createElement('div');
        const name = document.createElement('p');
        name.className = 'rd-redeem-item__name';
        name.textContent = title;
        const meta = document.createElement('p');
        meta.className = 'rd-redeem-item__meta';
        meta.textContent = `${type === 'xp' ? 'XP aplicado' : 'Brinde'} · ${formatRedeemDate(item.redeemed_at)}`;
        copy.append(name, meta);

        const status = document.createElement('span');
        status.className = `rd-redeem-item__status rd-redeem-item__status--${statusClass}`;
        status.textContent = statusLabel;
        row.append(icon, copy, status);
        list.appendChild(row);
    });
}

async function loadRedeemHistory() {
    const loading = document.getElementById('rd-history-loading');
    const list = document.getElementById('rd-history-list');
    const empty = document.getElementById('rd-history-empty');
    if (!loading || !list || !empty) return;

    loading.hidden = false;
    list.hidden = true;
    empty.hidden = true;
    try {
        const response = await fetch(`${getRedeemApi()}/api/redeem/history`, { credentials: 'include' });
        if (!response.ok) throw new Error('history_unavailable');
        renderRedeemHistory(await response.json());
    } catch (_) {
        loading.hidden = true;
        empty.hidden = false;
        empty.querySelector('strong').textContent = 'Não foi possível carregar seus resgates';
        empty.querySelector('p').textContent = 'Tente atualizar a página em instantes.';
    }
}

function amlDrawOne(stage, sym, onDone) {
    const gen = _amlGen;
    stage.innerHTML =
        '<div style="position:relative;width:28px;height:28px">' +
        '<svg class="aml-sym" viewBox="0 0 28 28">' + AML_SYMBOLS[sym] + '</svg>' +
        AML_SPARK + '</div>';
    const wrap = stage.firstChild;
    const svg = wrap.querySelector('.aml-sym');
    const spark = wrap.querySelector('.aml-spark');
    setTimeout(() => {
        if (_amlGen !== gen) return;
        svg.classList.add('aml-pulse');
        if (spark) spark.classList.add('on');
        setTimeout(() => {
            if (_amlGen !== gen) return;
            onDone();
        }, 360);
    }, 420);
}

function runAmlFlow(stage, flow, onComplete) {
    _amlGen++;
    const gen = _amlGen;
    let i = 0;
    const step = () => {
        if (_amlGen !== gen) return;
        if (i >= flow.length) { onComplete(); return; }
        const sym = flow[i++];
        amlDrawOne(stage, sym, step);
    };
    step();
}

function setupRedeemForm() {
    const form = document.getElementById('redeem-form');
    const codeInput = document.getElementById('code-input');
    const submitBtn = document.getElementById('btn-redeem');
    const hint = document.getElementById('rd-hint');
    const resultDiv = document.getElementById('redeem-result');
    const resultIcon = document.getElementById('result-icon');
    const resultTitle = document.getElementById('result-title');
    const resultMessage = document.getElementById('result-message');
    const stage = submitBtn?.querySelector('.aml-stage');

    if (!form || !stage) {
        console.error('[Resgatar] Form/stage not found');
        return;
    }

    const ICONS = {
        ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        er: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    function showResult(type, title, message) {
        resultDiv.className = `rd-result rd-result--${type}`;
        resultDiv.hidden = false;
        resultIcon.innerHTML = ICONS[type] || ICONS.info;
        resultTitle.textContent = title;
        resultMessage.textContent = message;
        resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const REDEEM_API = getRedeemApi();

    async function postRedeem(code) {
        const idempotencyKey = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const res = await fetch(`${REDEEM_API}/api/redeem`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo: code, idempotency_key: idempotencyKey })
        });
        let data = {};
        try { data = await res.json(); } catch (_) {}
        return { status: res.status, data };
    }

    function renderOutcome(outcome) {
        if (outcome.networkError) {
            showResult('er', 'Sem conexão', 'Não foi possível resgatar agora. Verifique sua conexão e tente de novo.');
            return;
        }
        const { status, data } = outcome;
        if (status === 503) {
            showResult('info', 'Resgate indisponível', 'O resgate está temporariamente indisponível. Tente de novo em instantes.');
            return;
        }
        if (status === 429) {
            showResult('er', 'Muitas tentativas', 'Aguarde um instante antes de tentar novamente.');
            return;
        }
        if (status === 409) {
            showResult('er', 'Resgate em andamento', 'Já há um resgate em processamento. Aguarde um instante e tente de novo.');
            return;
        }
        if (data && data.ok) {
            if (data.reward_type === 'xp') {
                const xp = data.reward && data.reward.xp;
                showResult('ok', 'Resgate concluído!', xp ? `Você ganhou ${xp} XP.` : 'Recompensa aplicada à sua conta.');
            } else {
                const nome = data.reward && data.reward.nome;
                showResult('ok', 'Brinde reservado!', nome
                    ? `Seu brinde "${nome}" foi reservado. Aguarde as instruções de retirada.`
                    : 'Seu brinde foi reservado.');
            }
            return;
        }
        showResult('er', 'Não foi possível resgatar', (data && data.message) || 'Código inválido ou indisponível.');
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (submitBtn.classList.contains('loading')) return;

        const code = codeInput.value.trim();
        if (!code || code.length < 3) {
            hint.textContent = 'O código deve ter pelo menos 3 caracteres.';
            hint.classList.add('is-error');
            showResult('er', 'Código inválido', 'Confira o código e tente novamente.');
            codeInput.focus();
            return;
        }

        hint.classList.remove('is-error');
        resultDiv.hidden = true;
        submitBtn.classList.add('loading');
        submitBtn.setAttribute('aria-busy', 'true');

        // A animacao roda junto da requisicao e serve de indicador de carregamento.
        const animation = new Promise((resolve) => runAmlFlow(stage, RESGATE_FLOW, resolve));
        let outcome;
        try {
            outcome = await postRedeem(code);
        } catch (_) {
            outcome = { networkError: true };
        }
        await animation;

        submitBtn.classList.remove('loading');
        submitBtn.removeAttribute('aria-busy');
        stage.innerHTML = '';
        renderOutcome(outcome);
        if (outcome.data && outcome.data.ok) {
            codeInput.value = '';
            await loadRedeemHistory();
        }
    });

    codeInput.addEventListener('input', () => {
        if (!resultDiv.hidden) resultDiv.hidden = true;
        if (hint.classList.contains('is-error')) {
            hint.classList.remove('is-error');
            hint.textContent = 'Cada código pode ser resgatado uma única vez.';
        }
    });
}

window.addEventListener('scroll', () => {
    const header = document.getElementById('header');
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 10);
}, { passive: true });

async function initSyncIndicators() {
    const indicator = document.getElementById('sync-indicator');
    const iconEl = indicator?.querySelector('.sync-icon');
    const textEl = indicator?.querySelector('.sync-text');
    if (!indicator) return;

    const updateIcon = (state) => {
        if (!iconEl) return;
        const icons = {
            syncing: `<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>`,
            success: `<polyline points="20 6 9 17 4 12"/>`,
            idle: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`
        };
        iconEl.innerHTML = icons[state] || icons.idle;
    };

    updateIcon('syncing');
    indicator.className = 'sync-indicator syncing';
    if (textEl) textEl.textContent = 'Sincronizando...';

    setTimeout(() => {
        indicator.className = 'sync-indicator success';
        updateIcon('success');
        if (textEl) textEl.textContent = 'Sincronizado';

        setTimeout(() => {
            indicator.className = 'sync-indicator';
            updateIcon('idle');
            if (textEl) textEl.textContent = 'Pronto';
        }, 1200);
    }, 500);
}

document.addEventListener('DOMContentLoaded', async () => {
    const user = loadUserData();
    if (!user) return;

    await initSyncIndicators();
    setupRedeemForm();
    await loadRedeemHistory();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') document.body.classList.add('keyboard-navigation');
}, true);
document.addEventListener('pointerdown', () => {
    document.body.classList.remove('keyboard-navigation');
}, true);

window.toggleMobileMenu = toggleMobileMenu;
window.handleLogout = handleLogout;

(function() {
    const todayStr = new Date().toLocaleDateString('pt-BR');
    const storageKey = `cx-daily-game-seen-${todayStr}`;
    const bell = document.querySelector('.header__bell');

    if (localStorage.getItem(storageKey) === 'true') {
        if (bell) bell.classList.add('seen');
    }

    if (bell) {
        bell.addEventListener('click', (e) => {
            e.preventDefault();
            const isLocalHtml = window.location.pathname.endsWith('.html');
            const appUrl = isLocalHtml ? 'app.html?playDaily=true' : '/app?playDaily=true';
            window.location.href = appUrl;
        });
    }
})();
