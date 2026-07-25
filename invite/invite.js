(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = (params.get('token') || '').trim().toLowerCase();
  var state = { accountExists: false, avatar: null, nickname: null };
  var activationMorphGeneration = 0;

  var ACTIVATION_AML_SYMBOLS = {
    ec: '<text x="14" y="19" font-family="DM Sans" font-weight="800" font-size="13" fill="currentColor" stroke="none" text-anchor="middle">EC</text>',
    sentury: '<rect x="6" y="9" width="16" height="12" rx="3" class="activation-aml-draw" style="--len:60"/><line x1="14" y1="5" x2="14" y2="9" class="activation-aml-draw" style="--len:6"/><circle cx="10.5" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.5" cy="15" r="1.3" fill="currentColor" stroke="none"/>',
    check: '<polyline points="6,14.5 12,20 22,8" class="activation-aml-draw" style="--len:26"/>'
  };

  function drawActivationMorph(stage, symbol, generation, done) {
    stage.innerHTML = '<svg class="activation-aml-symbol" viewBox="0 0 28 28" aria-hidden="true">' + ACTIVATION_AML_SYMBOLS[symbol] + '</svg>';
    window.setTimeout(function () {
      if (activationMorphGeneration !== generation) return;
      stage.firstElementChild.classList.add('activation-aml-pulse');
      window.setTimeout(function () {
        if (activationMorphGeneration === generation) done();
      }, 360);
    }, 420);
  }

  function startActivationMorph(button) {
    var stage = button.querySelector('.cl-stage');
    var text = button.querySelector('.cl-text');
    if (!stage || !text) {
      button.disabled = true;
      return { complete: function (callback) { callback(); }, reset: function () { button.disabled = false; } };
    }

    var generation = ++activationMorphGeneration;
    var index = 0;
    if (!button.dataset.label) button.dataset.label = text.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('loading');

    function next() {
      if (activationMorphGeneration !== generation) return;
      drawActivationMorph(stage, index % 2 === 0 ? 'ec' : 'sentury', generation, next);
      index += 1;
    }

    window.setTimeout(next, 180);

    return {
      complete: function (callback) {
        if (activationMorphGeneration !== generation) return;
        var confirmationGeneration = ++activationMorphGeneration;
        drawActivationMorph(stage, 'check', confirmationGeneration, function () {
          button.classList.remove('loading');
          button.classList.add('confirmed');
          button.removeAttribute('aria-busy');
          text.textContent = button.dataset.done || 'Concluído';
          stage.innerHTML = '';
          window.setTimeout(callback, 180);
        });
      },
      reset: function () {
        if (activationMorphGeneration !== generation) return;
        activationMorphGeneration += 1;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.classList.remove('loading', 'confirmed');
        text.innerHTML = button.dataset.label;
        stage.innerHTML = '';
      }
    };
  }

  function showState(name) {
    ['loading', 'error', 'form', 'success'].forEach(function (part) {
      document.getElementById(part + '-state').classList.toggle('hidden', part !== name);
    });
    document.getElementById('loading-state').setAttribute('aria-busy', name === 'loading' ? 'true' : 'false');
  }

  function showError(message) {
    var chip = document.getElementById('error-status-chip');
    var title = document.getElementById('error-title');
    if (/j[aá] foi usado|expirou/i.test(message)) {
      chip.textContent = 'LINK ENCERRADO';
      title.textContent = 'LINK ENCERRADO';
    } else if (/inv[aá]lido/i.test(message)) {
      chip.textContent = 'LINK INVÁLIDO';
      title.textContent = 'LINK INVÁLIDO';
    } else {
      chip.textContent = 'NÃO FOI POSSÍVEL VERIFICAR';
      title.textContent = 'NÃO FOI POSSÍVEL CONTINUAR';
    }
    document.getElementById('error-message').textContent = message;
    showState('error');
  }

  function keepValidationVisible(startedAt) {
    var remaining = 520 - (Date.now() - startedAt);
    return remaining > 0 ? new Promise(function (resolve) { window.setTimeout(resolve, remaining); }) : Promise.resolve();
  }

  function showStep(name, number) {
    ['code', 'character', 'passkey'].forEach(function (part) {
      document.getElementById('step-' + part).classList.toggle('hidden', part !== name);
      document.getElementById('step-' + part).classList.toggle('active', part === name);
    });
    document.querySelectorAll('#step-indicator .step').forEach(function (step) {
      step.classList.toggle('active', Number(step.dataset.step) <= number);
    });
  }

  function localSession(user) {
    var storage = window.CxSession?.getPrimaryStorage?.() || sessionStorage;
    storage.setItem('cx_logged_in_user', user.id);
    storage.setItem('cx_logged_in_user_email', user.nickname || '');
    storage.setItem('loggedIn', 'true');
    var users = JSON.parse(storage.getItem('cx_users') || '{}');
    users[user.id] = Object.assign({ level: 1, xp: 0, completedChallenges: [] }, users[user.id] || {}, {
      nickname: user.nickname || '', avatar_file_name: user.avatar_file_name || null
    });
    storage.setItem('cx_users', JSON.stringify(users));
  }

  async function initializeAvatarSelector() {
    var container = document.getElementById('avatar-selector-container');
    var next = document.getElementById('character-next');
    var selector = new window.AvatarSelector(container, {
      onSelect: function (filename) {
        state.avatar = filename;
        next.disabled = false;
        document.getElementById('avatar-error').classList.add('hidden');
      }
    });
    try {
      await selector.init();
    } catch (error) {
      document.getElementById('avatar-error').textContent = 'Não foi possível carregar os personagens. Recarregue a página.';
      document.getElementById('avatar-error').classList.remove('hidden');
    }
  }

  document.getElementById('code-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var input = document.getElementById('invite-code');
    var error = document.getElementById('code-error');
    var code = input.value.trim().toUpperCase();
    var button = event.currentTarget.querySelector('button');
    error.classList.add('hidden');
    if (!/^EC-[A-F0-9]{4}-[A-F0-9]{5}-[A-F0-9]{5}$/.test(code)) {
      error.textContent = 'Digite o código no formato EC-1234-12345-12345.';
      error.classList.remove('hidden');
      return;
    }
    var morph = startActivationMorph(button);
    try {
      var result = await window.PasskeyClient.api('/activation/verify', { token: token, code: code });
      morph.complete(function () {
        state.accountExists = result.account_exists;
        state.nickname = result.nickname;
        var nicknameDisplay = document.getElementById('nickname-display');
        nicknameDisplay.textContent = result.nickname ? 'Conta confirmada: ' + result.nickname : 'Conta confirmada.';
        nicknameDisplay.classList.remove('identity-pending');
        if (state.accountExists) {
          document.querySelector('[data-step="2"]').style.display = 'none';
          document.querySelectorAll('#step-indicator .step-line')[0].style.display = 'none';
          document.getElementById('activation-intro').textContent = 'Sua conta existe. Cadastre uma nova passkey sem alterar seu personagem.';
          showStep('passkey', 3);
        } else {
          showStep('character', 2);
          initializeAvatarSelector();
        }
      });
    } catch (exception) {
      error.textContent = exception.message || 'Não foi possível validar o código.';
      error.classList.remove('hidden');
      morph.reset();
    }
  });

  document.getElementById('character-next').addEventListener('click', function () {
    if (!state.avatar) return;
    showStep('passkey', 3);
  });

  document.getElementById('create-passkey').addEventListener('click', async function (event) {
    var button = event.currentTarget;
    var error = document.getElementById('passkey-error');
    error.classList.add('hidden');
    var morph = startActivationMorph(button);
    try {
      var result = await window.PasskeyClient.registerPasskey(state.accountExists ? {} : { avatar_file_name: state.avatar });
      morph.complete(function () {
        localSession(result.user);
        showState('success');
        window.setTimeout(function () { window.location.replace('/app'); }, 900);
      });
    } catch (exception) {
      error.textContent = exception.message || 'Não foi possível criar a passkey.';
      error.classList.remove('hidden');
      morph.reset();
    }
  });

  async function initializeActivation() {
    var validationStartedAt = Date.now();
    if (!/^[a-f0-9]{64}$/.test(token)) {
      await keepValidationVisible(validationStartedAt);
      showError('Este link de ativação é inválido. Peça um novo convite ao administrador.');
      return;
    }
    try {
      var status = await window.PasskeyClient.api('/activation/status', { token: token });
      if (!status.valid) {
        await keepValidationVisible(validationStartedAt);
        showError('Este link já foi usado ou expirou. Solicite um novo acesso ao administrador.');
        return;
      }
      await keepValidationVisible(validationStartedAt);
      showState('form');
      showStep('code', 1);
    } catch (exception) {
      await keepValidationVisible(validationStartedAt);
      showError('Não foi possível validar este link agora. Tente novamente em instantes.');
    }
  }

  initializeActivation();
})();
