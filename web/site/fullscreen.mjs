export const editable = target => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
export const FULLSCREEN_IDLE_MS = 2000;

export class FullscreenControls {
  constructor({ element, button, canvas = element.querySelector('canvas'), notify = () => {}, onChange = () => {} }) {
    this.element = element;
    this.button = button;
    this.canvas = canvas;
    this.notify = notify;
    this.onChange = onChange;
    this.idleTimer = null;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this.supported = !ios && matchMedia('(any-pointer: fine)').matches && Boolean(document.fullscreenEnabled && element.requestFullscreen);
    button.hidden = !this.supported;
    button.addEventListener('click', () => { void this.toggle(); });
    document.addEventListener('fullscreenchange', () => {
      this.update();
      if (this.active && document.body.dataset.state === 'playing') this.canvas?.focus({ preventScroll: true });
      requestAnimationFrame(() => this.onChange());
    });
    document.addEventListener('fullscreenerror', () => notify('Fullscreen was declined by the browser. Flight still works in this window.'));
    addEventListener('keydown', event => {
      if (event.code === 'Tab' && this.active) this.reveal();
      if (!this.supported || editable(event.target) || document.querySelector('dialog[open]') || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      if (event.code === 'Escape' && this.active) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.toggle();
      } else if (event.code === 'KeyF') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.toggle();
      }
    }, { capture: true });
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'focusin', 'focusout']) element.addEventListener(type, () => this.reveal(), { passive: true });
    this.stateObserver = new MutationObserver(() => this.reveal());
    this.stateObserver.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
    this.update();
  }

  get active() { return document.fullscreenElement === this.element; }

  get canHide() {
    const focused = document.activeElement;
    return this.active && document.body.dataset.state === 'playing' && !document.querySelector('dialog[open]')
      && !(this.element.contains(focused) && focused?.closest('button, a, input, select, textarea, [contenteditable="true"]'));
  }

  reveal() {
    clearTimeout(this.idleTimer);
    this.element.classList.remove('fullscreen-idle');
    if (this.canHide) this.idleTimer = setTimeout(() => {
      if (this.canHide) this.element.classList.add('fullscreen-idle');
    }, FULLSCREEN_IDLE_MS);
  }

  update() {
    this.button.textContent = this.active ? 'EXIT / ESC' : 'FULLSCREEN';
    this.button.setAttribute('aria-label', this.active ? 'Exit fullscreen (Escape)' : 'Enter fullscreen (F)');
    this.button.setAttribute('aria-pressed', String(this.active));
    this.button.title = this.active ? 'Exit fullscreen (Escape or F)' : 'Fullscreen (F)';
    this.reveal();
  }

  async toggle() {
    if (!this.supported) return;
    try {
      if (this.active) await document.exitFullscreen();
      else await this.element.requestFullscreen({ navigationUI: 'hide' });
    } catch (error) {
      console.warn('Native fullscreen was declined.', error?.name);
      this.notify('The browser declined fullscreen. Try the button again after focusing the page.');
    }
  }
}
