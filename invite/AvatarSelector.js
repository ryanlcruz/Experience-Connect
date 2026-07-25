function avatarSelectorDebugLog(...args) {
  if (typeof window !== 'undefined' && window.CX_DEBUG === true) {
    console.debug(...args);
  }
}

class AvatarSelector {
  constructor(containerElement, options = {}) {
    if (!containerElement) {
      throw new Error('AvatarSelector requires a container element');
    }

    this.container = containerElement;
    this.avatars = [];
    this.selectedAvatar = null;
    this.metadata = null;
    this.metadataLoader = null;
    this.onSelect = options.onSelect || (() => {});
    this.pageSize = Math.max(1, Number(options.pageSize) || 6);
    this.currentPage = 0;
  }

  async init() {
    try {
      await this.loadMetadata();
      await this.loadAvatars();
      this.render();
    } catch (error) {
      console.error('[AvatarSelector] Initialization error:', error);
      throw error;
    }
  }

  async loadMetadata() {
    try {
      if (!this.metadataLoader) {
        this.metadataLoader = new AvatarMetadataLoader();
      }

      const result = await this.metadataLoader.load();

      if (result.success) {
        this.metadata = result.data;
        avatarSelectorDebugLog('[AvatarSelector] Metadata loaded successfully');
      } else {
        console.warn('[AvatarSelector] Metadata load failed, using fallback:', result.error);
        this.metadata = null;
      }
    } catch (error) {
      console.error('[AvatarSelector] Metadata loading error:', error);
      this.metadata = null;
    }
  }

  async loadAvatars() {
    const avatarFilenames = [
      'h3535.webp', 'h4234.webp', 'h4244.webp', 'h45234.webp', 'h5234.webp',
      'h52344.webp', 'h5345.webp', 'h53534.webp', 'h5354.webp', 'h5355.webp',
      'h5635.webp', 'h7545.webp', 'h8724.webp', 'm3345.webp', 'm4245.webp',
      'm4523.webp', 'm5353.webp', 'm5354.webp', 'm5367.webp', 'm5444.webp',
      'm6345.webp', 'm6735.webp'
    ];
    this.avatars = avatarFilenames.map(filename => {
      const info = this.metadataLoader
        ? this.metadataLoader.getAvatarInfo(filename)
        : { name: filename.replace(/\.(webp|png)$/i, ''), description: '' };
      return { filename, name: info.name, description: info.description, url: `/frontend/assets/image/avatar/${filename}` };
    });
    avatarSelectorDebugLog(`[AvatarSelector] Loaded ${this.avatars.length} local avatars`);
    this.shuffleAvatars();
  }

  // Fisher-Yates shuffle to mix male/female avatars randomly
  shuffleAvatars() {
    for (let i = this.avatars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.avatars[i], this.avatars[j]] = [this.avatars[j], this.avatars[i]];
    }
    avatarSelectorDebugLog('[AvatarSelector] Avatars shuffled for random distribution');
  }

  render() {
    this.renderCurrentPage();

    avatarSelectorDebugLog(`[AvatarSelector] Rendered page ${this.currentPage + 1}/${this.getPageCount()} with ${Math.min(this.pageSize, this.avatars.length)} of ${this.avatars.length} avatars`);
  }

  getPageCount() {
    return Math.max(1, Math.ceil(this.avatars.length / this.pageSize));
  }

  renderCurrentPage() {
    const pageCount = this.getPageCount();
    this.currentPage = Math.min(Math.max(this.currentPage, 0), pageCount - 1);
    this.container.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'avatar-grid';

    const start = this.currentPage * this.pageSize;
    const pageAvatars = this.avatars.slice(start, start + this.pageSize);
    pageAvatars.forEach(avatar => {
      const card = this.createAvatarCard(avatar);
      grid.appendChild(card);
    });

    this.container.appendChild(grid);

    if (pageCount > 1) {
      const pagination = document.createElement('nav');
      pagination.className = 'avatar-pagination';
      pagination.setAttribute('aria-label', 'Paginação de personagens');

      const previous = this.createPageControl('previous', 'Página anterior', this.currentPage === 0);
      const pageLabel = document.createElement('span');
      pageLabel.className = 'avatar-page-label';
      pageLabel.textContent = `${this.currentPage + 1} de ${pageCount}`;
      pageLabel.setAttribute('aria-live', 'polite');
      const next = this.createPageControl('next', 'Próxima página', this.currentPage === pageCount - 1);

      previous.addEventListener('click', () => {
        this.currentPage -= 1;
        this.renderCurrentPage();
      });
      next.addEventListener('click', () => {
        this.currentPage += 1;
        this.renderCurrentPage();
      });

      pagination.append(previous, pageLabel, next);
      this.container.appendChild(pagination);
    }
  }

  createPageControl(direction, label, disabled) {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = `avatar-page-control avatar-page-control-${direction}`;
    control.disabled = disabled;
    control.setAttribute('aria-label', label);
    control.innerHTML = direction === 'previous'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5 7.5 12l7 7"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5 7 7-7 7"/></svg>';
    return control;
  }

  createAvatarCard(avatar) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'avatar-card';
    card.dataset.filename = avatar.filename;
    card.setAttribute('aria-label', `Escolher personagem: ${avatar.name}`);
    card.setAttribute('aria-pressed', String(this.selectedAvatar === avatar.filename));
    if (this.selectedAvatar === avatar.filename) card.classList.add('selected');

    const imgContainer = document.createElement('div');
    imgContainer.className = 'avatar-image-container';

    const skeleton = document.createElement('div');
    skeleton.className = 'avatar-skeleton';
    skeleton.setAttribute('aria-label', 'Loading avatar...');
    imgContainer.appendChild(skeleton);

    const img = document.createElement('img');
    img.src = avatar.url;
    img.alt = avatar.name;
    img.className = 'avatar-image';
    img.loading = 'lazy';
    img.draggable = false;

    img.onerror = () => {
      console.error(`[AvatarSelector] Failed to load avatar: ${avatar.filename}`);
      imgContainer.classList.add('avatar-error');
      imgContainer.classList.add('avatar-loaded');
      img.src = '/frontend/assets/image/avatar/h3535.webp';
    };

    img.onload = () => {
      imgContainer.classList.add('avatar-loaded');
    };

    imgContainer.appendChild(img);
    card.appendChild(imgContainer);

    if (avatar.name) {
      const nameOverlay = document.createElement('div');
      nameOverlay.className = 'avatar-name-overlay';
      nameOverlay.textContent = avatar.name;
      card.appendChild(nameOverlay);
    }

    const startExclusiveReveal = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));

        const { DEFAULT_TIMING_CONFIG } = window.TimingConfig || {};
        const config = DEFAULT_TIMING_CONFIG || {};

        if (!document.getElementById('exclusive-reveal-responsive-css')) {
          const link = document.createElement('link');
          link.id = 'exclusive-reveal-responsive-css';
          link.rel = 'stylesheet';
          link.href = '/invite/exclusive-reveal-responsive.css';
          document.head.appendChild(link);
        }

        const logumContainer = document.createElement('div');
        logumContainer.id = 'logum-reveal-container';
        document.body.appendChild(logumContainer);

        const logumController = new window.LogumAnimationController(logumContainer);

        const revealFlow = new window.ExclusiveAvatarRevealFlow(
          window.exclusivePersonaSystem,
          logumController,
          config
        );

        revealFlow.addEventListener('stateChange', (data) => {
          avatarSelectorDebugLog(`[RevealFlow] State: ${data.from} → ${data.to}`);
        });

        revealFlow.addEventListener('error', (data) => {
          console.error(`[RevealFlow] Error in state ${data.state}:`, data.error);
        });

        revealFlow.addEventListener('flowComplete', (data) => {
          avatarSelectorDebugLog(`[RevealFlow] Flow completed, selected: ${data.selectedAvatar}`);

          if (window.exclusivePersonaSystem.onComplete) {
            window.exclusivePersonaSystem.onComplete(data.selectedAvatar);
          }

          if (logumContainer && logumContainer.parentNode) {
            logumContainer.remove();
          }
        });

        await revealFlow.start();

      } catch (error) {
        console.error('[AvatarSelector] Exclusive reveal flow error:', error);
        openAvatarModal({
          filename: avatar.filename,
          name: avatar.name,
          description: avatar.description,
          imagePath: `/frontend/assets/image/avatar/${avatar.filename}`
        });
      }
    };

    // Selection is immediate in the passkey activation flow. The old modal
    // depended on the password-era invite script and is intentionally gone.
    card.addEventListener('click', () => this.handleSelection(avatar.filename));

    card.addEventListener('mouseenter', () => {
      card.classList.add('avatar-hover');
    });

    card.addEventListener('mouseleave', () => {
      card.classList.remove('avatar-hover');
    });

    return card;
  }

  handleSelection(avatarFilename) {
    avatarSelectorDebugLog('[AvatarSelector] handleSelection called with:', avatarFilename);

    this.selectedAvatar = avatarFilename;

    const allCards = this.container.querySelectorAll('.avatar-card');
    allCards.forEach(card => {
      if (card.dataset.filename === avatarFilename) {
        card.classList.add('selected');
        card.setAttribute('aria-pressed', 'true');
      } else {
        card.classList.remove('selected');
        card.setAttribute('aria-pressed', 'false');
      }
    });

    try {
      localStorage.setItem('cx_invite_avatar_selection', avatarFilename);
      avatarSelectorDebugLog(`[AvatarSelector] Avatar selected: ${avatarFilename}`);
    } catch (error) {
      console.warn('[AvatarSelector] localStorage unavailable:', error);
    }

    this.onSelect(avatarFilename);
  }

  getSelectedAvatar() {
    return this.selectedAvatar;
  }

  selectAvatar(avatarFilename) {
    this.handleSelection(avatarFilename);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AvatarSelector;
}

if (typeof window !== 'undefined') {
  window.AvatarSelector = AvatarSelector;
}
