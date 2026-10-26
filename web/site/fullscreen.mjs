export const editable = target => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));

export class FullscreenControls {
  constructor({ element, button, canvas = element.querySelector('canvas'), notify = () => {}, onChange = () => {} }) {
    this.element = element;
    this.button = button;
    this.canvas = canvas;
    this.notify = notify;
    this.onChange = onChange;
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
    this.update();
  }

  get active() { return document.fullscreenElement === this.element; }

  update() {
    this.button.textContent = this.active ? 'EXIT / ESC' : 'FULLSCREEN';
    this.button.setAttribute('aria-label', this.active ? 'Exit fullscreen (Escape)' : 'Enter fullscreen (F)');
    this.button.setAttribute('aria-pressed', String(this.active));
    this.button.title = this.active ? 'Exit fullscreen (Escape or F)' : 'Fullscreen (F)';
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
