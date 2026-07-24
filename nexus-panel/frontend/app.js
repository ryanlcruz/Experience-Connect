'use strict';

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : ' ok');
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    document.getElementById(id).classList.add('active');
    if (id === 'usuarios') loadUsers();
    if (id === 'desafios') loadChallenges();
    if (id === 'contextos') loadContexts();
    if (id === 'convites') loadInvites();
    if (id === 'temporada') loadSeason();
    if (id === 'reports') loadReports();
  });
});

const tipoSel = document.getElementById('tipo_reward');
tipoSel.addEventListener('change', () => {
  const xp = tipoSel.value === 'xp';
  document.getElementById('wrap-xp').hidden = !xp;
  document.getElementById('wrap-nome').hidden = xp;
});

function rewardText(row) {
  if (row.tipo_reward === 'xp') return `${(row.reward_payload || {}).xp ?? '?'} XP`;
  return `Brinde: ${esc((row.reward_payload || {}).nome ?? '?')}`;
}
function janelaText(row) {
  const f = v => v ? new Date(v).toLocaleString('pt-BR') : '—';
  if (!row.inicio && !row.fim) return 'sempre';
  return `${f(row.inicio)} → ${f(row.fim)}`;
}

async function loadCodes() {
  const tbody = document.querySelector('#codes-table tbody');
  try {
    const rows = await api('/admin/redeem-codes');
    tbody.innerHTML = '';
    document.getElementById('codes-empty').hidden = rows.length > 0;
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${esc(r.codigo)}</code></td>
        <td>${rewardText(r)}</td>
        <td>${r.escopo === 'global_unico' ? 'Global único' : 'Por usuário'}</td>
        <td>${janelaText(r)}</td>
        <td>${r.resgatados ?? 0}</td>
        <td><button class="pill ${r.ativo ? 'on' : 'off'}">${r.ativo ? 'ativo' : 'inativo'}</button></td>
        <td class="actions"><button class="mini edit">editar</button><button class="mini danger">apagar</button></td>`;
      tr.querySelector('.pill').addEventListener('click', () => toggleCode(r));
      tr.querySelector('.edit').addEventListener('click', () => editCode(r, tr));
      tr.querySelector('.danger').addEventListener('click', () => deleteCode(r));
      tbody.appendChild(tr);
    }
  } catch (e) { toast('Erro ao carregar códigos: ' + e.message, true); }
}

async function toggleCode(row) {
  try {
    await api('/admin/redeem-codes/' + row.id, { method: 'PATCH', body: JSON.stringify({ ativo: !row.ativo }) });
    loadCodes();
  } catch (e) { toast('Erro ao alterar: ' + e.message, true); }
}

async function deleteCode(row) {
  if (!confirm(`Apagar o código "${row.codigo}"?`)) return;
  try {
    await api('/admin/redeem-codes/' + row.id, { method: 'DELETE' });
    toast('Código apagado.');
    loadCodes();
  } catch (e) { toast(e.message, true); }
}

// Edicao inline: janela (inicio/fim) + valor da recompensa.
function editCode(row, tr) {
  const dt = v => v ? String(v).slice(0, 16) : '';
  const isXp = row.tipo_reward === 'xp';
  const rp = row.reward_payload || {};
  tr.innerHTML = `
    <td><code>${esc(row.codigo)}</code></td>
    <td><input class="e-reward" type="${isXp ? 'number' : 'text'}" min="1" max="100000"
        value="${isXp ? esc(rp.xp ?? '') : esc(rp.nome ?? '')}" style="width:9rem"></td>
    <td>${row.escopo === 'global_unico' ? 'Global único' : 'Por usuário'}</td>
    <td><input class="e-inicio" type="datetime-local" value="${dt(row.inicio)}">
        <input class="e-fim" type="datetime-local" value="${dt(row.fim)}"></td>
    <td>${row.resgatados ?? 0}</td>
    <td colspan="2" class="actions">
      <button class="mini e-save">salvar</button>
      <button class="mini e-cancel">cancelar</button>
    </td>`;
  tr.querySelector('.e-cancel').addEventListener('click', loadCodes);
  tr.querySelector('.e-save').addEventListener('click', async () => {
    const rv = tr.querySelector('.e-reward').value;
    const body = {
      inicio: tr.querySelector('.e-inicio').value || null,
      fim: tr.querySelector('.e-fim').value || null,
      reward_payload: isXp ? { xp: Number(rv) } : { nome: (rv || '').trim() },
    };
    try {
      await api('/admin/redeem-codes/' + row.id, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Código atualizado.');
      loadCodes();
    } catch (e) { toast(e.message, true); }
  });
}

document.getElementById('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const tipo = fd.get('tipo_reward');
  const reward_payload = tipo === 'xp'
    ? { xp: Number(fd.get('xp')) }
    : { nome: (fd.get('nome') || '').trim() };
  const body = {
    codigo: (fd.get('codigo') || '').trim(),
    tipo_reward: tipo,
    reward_payload,
    escopo: fd.get('escopo'),
    inicio: fd.get('inicio') || null,
    fim: fd.get('fim') || null,
  };
  try {
    await api('/admin/redeem-codes', { method: 'POST', body: JSON.stringify(body) });
    toast('Código criado.');
    e.target.reset();
    document.getElementById('wrap-xp').hidden = false;
    document.getElementById('wrap-nome').hidden = true;
    loadCodes();
  } catch (err) { toast(err.message, true); }
});

async function loadUsers() {
  const form = document.getElementById('users-filter');
  const fd = new FormData(form);
  const qs = new URLSearchParams();
  if (fd.get('min_level')) qs.set('min_level', fd.get('min_level'));
  if (fd.get('min_xp')) qs.set('min_xp', fd.get('min_xp'));
  if (fd.get('banned')) qs.set('banned', 'true');
  const tbody = document.querySelector('#users-table tbody');
  try {
    const data = await api('/admin/users?' + qs.toString());
    const users = Array.isArray(data) ? data : (data.users || []);
    tbody.innerHTML = '';
    document.getElementById('users-empty').hidden = users.length > 0;
    for (const u of users) {
      const banned = u.banned || u.is_banned;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(u.display_name || u.displayname || u.nickname || u.id)}</td>
        <td>${u.level ?? '—'}</td>
        <td>${u.xp ?? '—'}</td>
        <td>${banned ? '<span class="tag ban">banido</span>' : 'ok'}</td>
        <td class="actions">
          <button class="mini ${banned ? 'on' : 'danger'}" data-act="${banned ? 'unban' : 'ban'}">${banned ? 'desbanir' : 'banir'}</button>
          <button class="mini" data-act="reset">reset</button>
          <button class="mini" data-act="recover">recuperar acesso</button>
          <button class="mini danger" data-act="del">excluir</button>
        </td>`;
      tr.querySelector('[data-act]').addEventListener('click', () => userAction(u.id, banned ? 'unban' : 'ban'));
      tr.querySelector('[data-act="reset"]').addEventListener('click', () => userAction(u.id, 'reset'));
      tr.querySelector('[data-act="recover"]').addEventListener('click', () => issuePasskeyRecovery(u));
      tr.querySelector('[data-act="del"]').addEventListener('click', () => userAction(u.id, 'del'));
      tbody.appendChild(tr);
    }
  } catch (e) { toast('Erro ao carregar usuários: ' + e.message, true); }
}

async function userAction(userId, act) {
  const map = { ban: 'banir', unban: 'desbanir', reset: 'resetar o progresso de', del: 'EXCLUIR (apaga 100% de)' };
  if (!confirm(`Confirma ${map[act]} este usuário?`)) return;
  if (act === 'del' && !confirm('Isso apaga o usuário e todo o progresso/tentativas. Irreversível. Confirmar?')) return;
  try {
    if (act === 'ban') await api(`/admin/users/${userId}/ban`, { method: 'POST', body: JSON.stringify({ reason: 'via painel' }) });
    else if (act === 'unban') await api(`/admin/users/${userId}/unban`, { method: 'POST', body: '{}' });
    else if (act === 'reset') await api(`/admin/users/${userId}/reset-progress`, { method: 'POST', body: '{}' });
    else if (act === 'del') await api(`/admin/users/${userId}`, { method: 'DELETE' });
    toast('Feito.');
    loadUsers();
  } catch (e) { toast(e.message, true); }
}

document.getElementById('users-filter').addEventListener('submit', (e) => { e.preventDefault(); loadUsers(); });
document.getElementById('btn-reset-all').addEventListener('click', async () => {
  if (!confirm('RESET ALL: zera o progresso de TODOS os usuários e apaga tentativas/fases. Tem certeza?')) return;
  if (!confirm('Isso é IRREVERSÍVEL. Confirmar de novo?')) return;
  try { await api('/admin/users/reset-all', { method: 'POST', body: '{}' }); toast('Reset all concluído.'); loadUsers(); }
  catch (e) { toast(e.message, true); }
});

function closeRecoveryModal() {
  document.getElementById('recovery-modal').hidden = true;
}

async function copyRecoveryValue(elementId, label) {
  const element = document.getElementById(elementId);
  try {
    await navigator.clipboard.writeText(element.value);
    toast(`${label} copiado.`);
  } catch (_) {
    element.select();
    document.execCommand('copy');
    toast(`${label} copiado.`);
  }
}

function showPasskeyGrant({ title, summary, note, linkLabel, codeLabel, expiresFallback, grant }) {
  document.getElementById('recovery-title').textContent = title;
  document.getElementById('recovery-summary').textContent = summary;
  document.getElementById('recovery-note').textContent = note;
  document.getElementById('recovery-link-label').firstChild.textContent = linkLabel;
  document.getElementById('recovery-code-label').firstChild.textContent = codeLabel;
  document.getElementById('recovery-link').value = grant.invite_url || '';
  document.getElementById('recovery-code').value = grant.invite_code || '';
  document.getElementById('recovery-expires').textContent = grant.invite_expires
    ? `Válido até ${new Date(grant.invite_expires).toLocaleString('pt-BR')}.`
    : expiresFallback;
  document.getElementById('recovery-modal').hidden = false;
}

function showRecoveryGrant(user, grant) {
  const displayName = user.display_name || user.displayname || user.nickname || user.id;
  showPasskeyGrant({
    title: 'Recuperação por passkey',
    summary: `Recuperação criada para ${displayName}.`,
    note: 'Envie o link e o código por canais separados. As passkeys já cadastradas permanecem válidas.',
    linkLabel: 'Link de recuperação',
    codeLabel: 'Código de recuperação',
    expiresFallback: 'Válido por 30 minutos.',
    grant,
  });
}

function showInviteGrant(nickname, grant) {
  showPasskeyGrant({
    title: 'Convite por passkey',
    summary: `Convite criado para ${nickname}.`,
    note: 'Copie o link e o código agora e envie-os por canais separados. Eles só são exibidos nesta emissão.',
    linkLabel: 'Link de ativação',
    codeLabel: 'Código de ativação',
    expiresFallback: 'Válido durante o evento.',
    grant,
  });
}

async function issuePasskeyRecovery(user) {
  const displayName = user.display_name || user.displayname || user.nickname || user.id;
  if (!confirm(`Criar uma recuperação de passkey para ${displayName}? O link e o código valem 30 minutos e substituem uma recuperação pendente.`)) return;
  try {
    const grant = await api(`/admin/users/${user.id}/passkey-recovery`, {
      method: 'POST',
      body: JSON.stringify({ created_by: 'nexus-panel' }),
    });
    if (!grant.invite_url || !grant.invite_code) throw new Error('A recuperação não retornou link e código.');
    showRecoveryGrant(user, grant);
  } catch (e) { toast(e.message, true); }
}

document.getElementById('recovery-close').addEventListener('click', closeRecoveryModal);
document.getElementById('recovery-modal').addEventListener('click', (event) => {
  if (event.target.id === 'recovery-modal') closeRecoveryModal();
});
document.getElementById('recovery-copy-link').addEventListener('click', () => copyRecoveryValue('recovery-link', 'Link'));
document.getElementById('recovery-copy-code').addEventListener('click', () => copyRecoveryValue('recovery-code', 'Código'));

async function loadSeason() {
  const card = document.getElementById('season-card');
  try {
    const s = await api('/admin/seasons/current');
    if (!s) { card.textContent = 'Nenhuma temporada cadastrada.'; return; }
    const dv = (v) => (v ? String(v).slice(0, 16) : '');
    card.innerHTML = `
      <p><b>${esc(s.nome || s.id)}</b> <span class="tag">${esc(s.id)}</span> · níveis: ${s.total_levels ?? '—'} · status: <b>${esc(s.status || '—')}</b></p>
      <div class="form-grid">
        <label>Status<input id="s-status" value="${esc(s.status || '')}"></label>
        <label>Início<input id="s-inicio" type="datetime-local" value="${dv(s.start_date)}"></label>
        <label>Fim<input id="s-fim" type="datetime-local" value="${dv(s.end_date)}"></label>
        <label>Nome<input id="s-nome" value="${esc(s.nome || '')}"></label>
      </div>
      <label>Descrição<input id="s-desc" value="${esc(s.descricao || '')}" style="width:100%"></label>
      <div class="inline" style="margin-top:.6rem">
        <button id="s-save">Salvar temporada</button>
        <button id="s-close" class="danger">Fechar temporada</button>
      </div>`;
    document.getElementById('s-save').addEventListener('click', async () => {
      const body = {
        status: document.getElementById('s-status').value.trim(),
        data_inicio: document.getElementById('s-inicio').value || null,
        data_fim: document.getElementById('s-fim').value || null,
        nome: document.getElementById('s-nome').value.trim(),
        descricao: document.getElementById('s-desc').value.trim(),
      };
      try {
        await api('/admin/seasons/' + s.id, { method: 'PATCH', body: JSON.stringify(body) });
        toast('Temporada salva.');
        loadSeason();
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('s-close').addEventListener('click', async () => {
      if (!confirm('Marcar a temporada como FECHADA no banco?')) return;
      try {
        await api('/admin/seasons/' + s.id, { method: 'PATCH', body: JSON.stringify({ status: 'fechada' }) });
        toast('Temporada fechada.');
        loadSeason();
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { card.textContent = 'Erro ao carregar temporada: ' + e.message; }
}

async function loadReports() {
  const map = {
    '/reports/user-retention': 'rep-retention',
    '/reports/daily-activity': 'rep-activity',
    '/reports/xp-distribution': 'rep-xp',
    '/reports/challenge-difficulty': 'rep-difficulty',
  };
  for (const [path, id] of Object.entries(map)) {
    try {
      const data = await api(path);
      document.getElementById(id).textContent = JSON.stringify(data, null, 2);
    } catch (e) { document.getElementById(id).textContent = 'erro: ' + e.message; }
  }
}

document.getElementById('ch-load').addEventListener('click', loadChallenges);
document.getElementById('ch-new').addEventListener('click', () => openChallengeEditor(null));

async function loadChallenges() {
  const qs = new URLSearchParams();
  const season = document.getElementById('ch-season').value.trim();
  const setor = document.getElementById('ch-setor').value.trim();
  const level = document.getElementById('ch-level').value;
  if (season) qs.set('season_id', season);
  if (setor) qs.set('setor', setor);
  if (level) qs.set('level', level);
  const tbody = document.querySelector('#ch-table tbody');
  try {
    const rows = await api('/admin/challenges?' + qs.toString());
    tbody.innerHTML = '';
    document.getElementById('ch-empty').hidden = rows.length > 0;
    for (const c of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${esc(c.challenge_id)}</code></td>
        <td>${esc(c.tipo)}</td>
        <td>${esc(c.titulo)}</td>
        <td>${esc(c.categoria || '—')}</td>
        <td>${c.xp ?? '—'}</td>
        <td><button class="pill ${c.ativo ? 'on' : 'off'}">${c.ativo ? 'ativo' : 'inativo'}</button></td>
        <td class="actions"><button class="mini edit">editar</button><button class="mini danger">apagar</button></td>`;
      tr.querySelector('.pill').addEventListener('click', () => toggleChallenge(c));
      tr.querySelector('.edit').addEventListener('click', () => openChallengeEditor(c.challenge_id));
      tr.querySelector('.danger').addEventListener('click', () => deleteChallenge(c));
      tbody.appendChild(tr);
    }
  } catch (e) { toast('Erro ao carregar desafios: ' + e.message, true); }
}

async function toggleChallenge(c) {
  try { await api('/admin/challenges/' + c.challenge_id, { method: 'PATCH', body: JSON.stringify({ ativo: !c.ativo }) }); loadChallenges(); }
  catch (e) { toast(e.message, true); }
}

async function deleteChallenge(c) {
  if (!confirm(`Apagar o desafio "${c.challenge_id}" e seu gabarito?`)) return;
  try { await api('/admin/challenges/' + c.challenge_id, { method: 'DELETE' }); toast('Desafio apagado.'); loadChallenges(); }
  catch (e) { toast(e.message, true); }
}

async function openChallengeEditor(challengeId) {
  const box = document.getElementById('ch-editor');
  const isNew = !challengeId;
  let ch = {
    season_id: document.getElementById('ch-season').value.trim(),
    setor: document.getElementById('ch-setor').value.trim() || 'CX',
    level: Number(document.getElementById('ch-level').value) || 1,
    tipo: 'seleção', alternativas: {}, ativo: true, answer_key: {},
  };
  if (!isNew) {
    try { ch = await api('/admin/challenges/' + challengeId); } catch (e) { toast(e.message, true); return; }
  }
  const ak = ch.answer_key || {};
  const alt = ch.alternativas || {};
  const opt = (l) => `<option value="${l}" ${ak.resposta_correta === l ? 'selected' : ''}>${l}</option>`;
  box.hidden = false;
  box.innerHTML = `
    <h3>${isNew ? 'Novo desafio' : 'Editar: ' + esc(challengeId)}</h3>
    <div class="form-grid">
      <label>ID<input id="e-id" value="${esc(challengeId || '')}" ${isNew ? '' : 'disabled'}></label>
      <label>Temporada<input id="e-season" value="${esc(ch.season_id || '')}"></label>
      <label>Setor<input id="e-setor" value="${esc(ch.setor || 'CX')}"></label>
      <label>Nível<input id="e-level" type="number" min="1" value="${ch.level || 1}"></label>
      <label>Tipo<select id="e-tipo">
        <option value="seleção" ${ch.tipo === 'seleção' ? 'selected' : ''}>seleção</option>
        <option value="texto" ${ch.tipo === 'texto' ? 'selected' : ''}>texto</option>
        <option value="intermission" ${ch.tipo === 'intermission' ? 'selected' : ''}>intermission</option>
      </select></label>
      <label>Categoria<input id="e-cat" value="${esc(ch.categoria || '')}"></label>
      <label>XP<input id="e-xp" type="number" value="${ch.xp ?? ''}"></label>
      <label>Tempo (s)<input id="e-tempo" type="number" value="${ch.tempo_limite ?? ''}"></label>
      <label>Ordem<input id="e-ordem" type="number" value="${ch.ordem ?? ''}"></label>
      <label class="chk"><input id="e-ativo" type="checkbox" ${ch.ativo ? 'checked' : ''}> ativo</label>
    </div>
    <label>Título<input id="e-titulo" value="${esc(ch.titulo || '')}" style="width:100%"></label>
    <label>Descrição<textarea id="e-desc" rows="3" style="width:100%">${esc(ch.descricao || '')}</textarea></label>
    <div class="form-grid">
      <label>Alt. A<input id="e-alt-A" value="${esc(alt.A || '')}"></label>
      <label>Alt. B<input id="e-alt-B" value="${esc(alt.B || '')}"></label>
      <label>Alt. C<input id="e-alt-C" value="${esc(alt.C || '')}"></label>
      <label>Alt. D<input id="e-alt-D" value="${esc(alt.D || '')}"></label>
    </div>
    <div class="form-grid">
      <label class="chk"><input id="e-istext" type="checkbox" ${ak.is_text_question ? 'checked' : ''}> questão de texto (IA)</label>
      <label>Resposta correta<select id="e-resp"><option value="">—</option>${['A', 'B', 'C', 'D'].map(opt).join('')}</select></label>
      <label>Pontos<input id="e-points" type="number" value="${ak.points ?? ch.xp ?? ''}"></label>
    </div>
    <div class="inline">
      <button id="e-save">${isNew ? 'Criar' : 'Salvar'}</button>
      <button id="e-cancel" class="mini">fechar</button>
    </div>`;
  document.getElementById('e-cancel').addEventListener('click', () => { box.hidden = true; });
  document.getElementById('e-save').addEventListener('click', () => saveChallenge(isNew, challengeId));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveChallenge(isNew, challengeId) {
  const v = (id) => document.getElementById(id).value.trim();
  const alternativas = {};
  for (const l of ['A', 'B', 'C', 'D']) { const val = v('e-alt-' + l); if (val) alternativas[l] = val; }
  const isText = document.getElementById('e-istext').checked;
  const content = {
    season_id: v('e-season'), setor: v('e-setor'), level: Number(v('e-level')) || 1,
    tipo: v('e-tipo'), titulo: v('e-titulo'), descricao: v('e-desc'), categoria: v('e-cat'),
    alternativas, xp: v('e-xp') ? Number(v('e-xp')) : null,
    tempo_limite: v('e-tempo') ? Number(v('e-tempo')) : null,
    ordem: v('e-ordem') ? Number(v('e-ordem')) : null,
    ativo: document.getElementById('e-ativo').checked,
  };
  const answer = {
    is_text_question: isText,
    resposta_correta: isText ? null : (v('e-resp') || null),
    points: v('e-points') ? Number(v('e-points')) : null,
  };
  try {
    if (isNew) {
      const cid = v('e-id');
      if (!cid) { toast('ID obrigatório', true); return; }
      await api('/admin/challenges', { method: 'POST', body: JSON.stringify(Object.assign({ challenge_id: cid }, content, answer)) });
      toast('Desafio criado.');
    } else {
      await api('/admin/challenges/' + challengeId, { method: 'PATCH', body: JSON.stringify(content) });
      await api('/admin/challenges/' + challengeId + '/answer', { method: 'PATCH', body: JSON.stringify(answer) });
      toast('Desafio salvo.');
    }
    document.getElementById('ch-editor').hidden = true;
    loadChallenges();
  } catch (e) { toast(e.message, true); }
}

let invCache = [];
document.getElementById('inv-create').addEventListener('click', createInvite);
document.getElementById('inv-bulk-btn').addEventListener('click', createBulkInvites);
document.getElementById('inv-reload').addEventListener('click', loadInvites);
document.getElementById('inv-download').addEventListener('click', downloadInvitesCsv);
document.getElementById('inv-file').addEventListener('change', readInviteFile);
document.getElementById('inv-clear-used').addEventListener('click', async () => {
  if (!confirm('Apagar do banco todos os convites já USADOS?')) return;
  try { const r = await api('/admin/invites/clear-used', { method: 'POST', body: '{}' }); toast(`${r.deleted} convites usados apagados.`); loadInvites(); }
  catch (e) { toast(e.message, true); }
});

async function createInvite() {
  const nick = document.getElementById('inv-nick').value.trim();
  if (!nick) { toast('Informe o nickname', true); return; }
  try {
    const inv = await api('/admin/invites', { method: 'POST', body: JSON.stringify({ nickname: nick }) });
    if (!inv.invite_url || !inv.invite_code) throw new Error('O convite não retornou link e código.');
    document.getElementById('inv-nick').value = '';
    showInviteGrant(nick, inv);
    toast('Convite criado. Copie o link e o código.');
    loadInvites();
  } catch (e) { toast(e.message, true); }
}

function readInviteFile(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const nicks = String(reader.result).split(/\r?\n/).map(l => l.split(',')[0].trim()).filter(Boolean);
    // remove um possivel cabecalho "nickname"
    if (nicks[0] && /^nick|nome|user/i.test(nicks[0])) nicks.shift();
    document.getElementById('inv-bulk').value = nicks.join('\n');
    toast(`${nicks.length} nicknames carregados do arquivo.`);
  };
  reader.readAsText(file);
}

async function createBulkInvites() {
  const nicknames = document.getElementById('inv-bulk').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!nicknames.length) { toast('Cole ou envie a lista', true); return; }
  if (!confirm(`Criar ${nicknames.length} convites?`)) return;
  const box = document.getElementById('inv-bulk-result');
  try {
    const response = await fetch('/api/admin/invites/bulk.csv', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: nicknames.map(nickname => ({ nickname })), created_by: 'nexus-panel' }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${response.status}`);
    }
    const csv = await response.blob();
    const url = URL.createObjectURL(csv);
    const download = document.createElement('a');
    download.href = url;
    download.download = 'passkey-activation-grants.csv';
    download.click();
    URL.revokeObjectURL(url);
    box.hidden = false;
    box.textContent = `Arquivo com ${nicknames.length} emissão(ões) baixado. Confira a coluna status antes do envio.`;
    toast('CSV de ativação baixado.');
    loadInvites();
  } catch (e) { toast(e.message, true); }
}

async function loadInvites() {
  const tbody = document.querySelector('#inv-table tbody');
  try {
    invCache = await api('/admin/invites');
    tbody.innerHTML = '';
    document.getElementById('inv-empty').hidden = invCache.length > 0;
    for (const i of invCache) {
      const exp = i.expires_at ? new Date(i.expires_at).toLocaleDateString('pt-BR') : '—';
      const issued = i.created_at ? new Date(i.created_at).toLocaleString('pt-BR') : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(i.nickname)}</td>
        <td>${esc(i.grant_type || '—')}</td>
        <td>${esc(i.state || '—')}</td>
        <td>${exp}</td>
        <td>${issued}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) { toast('Erro ao carregar convites: ' + e.message, true); }
}

function downloadInvitesCsv() {
  if (!invCache.length) { toast('Carregue os convites primeiro', true); return; }
  const head = 'nickname,grant_type,state,expires_at,created_at';
  const rows = invCache.map(i => [i.nickname, i.grant_type, i.state, i.expires_at, i.created_at]
    .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = [head, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'passkey-grants-status.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('ctx-load').addEventListener('click', loadContexts);
document.getElementById('ctx-new').addEventListener('click', () => openContextEditor(null));

async function loadContexts() {
  const tbody = document.querySelector('#ctx-table tbody');
  try {
    const rows = await api('/admin/contexts');
    tbody.innerHTML = '';
    document.getElementById('ctx-empty').hidden = rows.length > 0;
    for (const c of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><code>${esc(c.challenge_id)}</code></td>
        <td class="actions"><button class="mini edit">editar</button><button class="mini danger">apagar</button></td>`;
      tr.querySelector('.edit').addEventListener('click', () => openContextEditor(c.challenge_id));
      tr.querySelector('.danger').addEventListener('click', () => deleteContext(c.challenge_id));
      tbody.appendChild(tr);
    }
  } catch (e) { toast('Erro ao carregar contextos: ' + e.message, true); }
}

async function deleteContext(id) {
  if (!confirm(`Apagar o contexto "${id}"?`)) return;
  try { await api('/admin/contexts/' + id, { method: 'DELETE' }); toast('Contexto apagado.'); loadContexts(); }
  catch (e) { toast(e.message, true); }
}

async function openContextEditor(challengeId) {
  const box = document.getElementById('ctx-editor');
  const isNew = !challengeId;
  let ctx = {};
  if (!isNew) {
    try { const c = await api('/admin/contexts/' + challengeId); ctx = c.context || {}; }
    catch (e) { toast(e.message, true); return; }
  }
  box.hidden = false;
  box.innerHTML = `
    <h3>${isNew ? 'Novo contexto' : 'Editar: ' + esc(challengeId)}</h3>
    <label>challenge_id<input id="cx-id" value="${esc(challengeId || '')}" ${isNew ? '' : 'disabled'}></label>
    <label>Contexto (JSON)<textarea id="cx-json" rows="18" style="width:100%;font-family:monospace;font-size:.82rem">${esc(JSON.stringify(ctx, null, 2))}</textarea></label>
    <div class="inline"><button id="cx-save">${isNew ? 'Criar' : 'Salvar'}</button><button id="cx-cancel" class="mini">fechar</button></div>`;
  document.getElementById('cx-cancel').addEventListener('click', () => { box.hidden = true; });
  document.getElementById('cx-save').addEventListener('click', async () => {
    const id = document.getElementById('cx-id').value.trim();
    if (!id) { toast('challenge_id obrigatório', true); return; }
    let parsed;
    try { parsed = JSON.parse(document.getElementById('cx-json').value); }
    catch (e) { toast('JSON inválido: ' + e.message, true); return; }
    try {
      await api('/admin/contexts/' + id, { method: 'PUT', body: JSON.stringify(parsed) });
      toast('Contexto salvo.');
      box.hidden = true;
      loadContexts();
    } catch (e) { toast(e.message, true); }
  });
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

loadCodes();
