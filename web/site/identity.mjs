import { startAuthentication, startRegistration } from './vendor/webauthn-browser-14.0.0.mjs';
import { isPublicHandle } from './handles.mjs?v=20261024.5';

const $ = id => document.getElementById(id);
const messages = {
  invalid_username: 'Use 3-20 ASCII letters, digits, or underscores. No spaces or look-alike Unicode characters.',
  username_reserved: 'That handle is reserved. Please choose another public alias.',
  username_unavailable: 'That handle is unavailable. Choose another, or sign in with its passkey.',
  authentication_required: 'Sign in with your passkey to play ranked.',
  reauthentication_required: 'Sign in again before adding a backup passkey.',
  passkey_verification_failed: 'The passkey could not be verified. Try again from curl.red.',
  challenge_expired: 'The one-use passkey challenge expired. Please try again.',
  csrf_rejected: 'Your security session changed. Reload this page before trying again.',
  rate_limited: 'Too many requests. Please wait a minute before trying again.',
  ranked_capacity: 'Ranked flight is busy. Please try again shortly; casual flight is always available.',
  ranked_unavailable: 'Ranked storage is unavailable. No score is being reported as saved.',
  passkey_limit: 'This account already has five passkeys.',
  passkey_already_registered: 'That passkey is already registered. Choose another authenticator or sign in with the existing passkey.',
  confirmation_mismatch: 'Type your public handle exactly to confirm account deletion.',
  run_exists: 'You already have a ranked flight. Resume or finish it first.',
  api_unavailable: 'Ranked accounts are offline. Casual flight and your local best still work.',
  connection_lost: 'The ranked connection was interrupted. Reconnect within ten minutes to continue.',
};

export class AccountError extends Error {
  constructor(code, status = 0) {
    super(messages[code] || 'The ranked request could not be completed. Please retry; no unverified score will be accepted.');
    this.code = code;
    this.status = status;
  }
}

export class Identity {
  constructor({ notify, onPause, onChange = () => {} }) {
    this.notify = notify;
    this.onPause = onPause;
    this.onChange = onChange;
    this.session = { authenticated: false, user: null, csrf: null };
    this.dialog = $('identity-dialog');
    this.supported = Boolean(isSecureContext && navigator.credentials && globalThis.PublicKeyCredential);
    this.available = true;
    this.busy = false;
    $('account').addEventListener('click', () => this.open());
    $('identity-close').addEventListener('click', () => this.dialog.close());
    $('register-form').addEventListener('submit', event => {
      event.preventDefault();
      void this.operation(async () => {
        const handle = $('username').value;
        if (!isPublicHandle(handle)) throw new AccountError('invalid_username');
        await this.bootstrap();
        const { options } = await this.request('/api/auth/register/options', { username: handle });
        const credential = await startRegistration({ optionsJSON: options });
        this.setSession(await this.request('/api/auth/register/verify', { credential }));
        $('username').value = '';
        this.status('Handle reserved with your passkey. Save a backup passkey or use your passkey provider recovery.');
      });
    });
    $('signin').addEventListener('click', () => { void this.signIn(); });
    $('reauthenticate').addEventListener('click', () => { void this.signIn(); });
    $('add-passkey').addEventListener('click', () => {
      void this.operation(async () => {
        const { options } = await this.request('/api/auth/passkey/options', {});
        const credential = await startRegistration({ optionsJSON: options });
        this.setSession(await this.request('/api/auth/passkey/verify', { credential }));
        this.status('Backup passkey added.');
      });
    });
    $('signout').addEventListener('click', () => {
      void this.operation(async () => {
        this.setSession(await this.request('/api/auth/logout', {}));
        this.status('Signed out. Any ranked flight is paused for up to ten minutes.');
      });
    });
    $('delete-form').addEventListener('submit', event => {
      event.preventDefault();
      void this.operation(async () => {
        const confirmation = $('delete-confirmation').value;
        if (confirmation !== this.session.user?.username) throw new AccountError('confirmation_mismatch');
        const { options } = await this.request('/api/auth/delete/options', {});
        const credential = await startAuthentication({ optionsJSON: options });
        this.setSession(await this.request('/api/auth/delete/verify', { credential, confirmation }));
        $('delete-confirmation').value = '';
        this.status('Account and public score deleted. Protected security audits expire within 90 days; the handle remains reserved for that period.');
        await this.loadScores();
      });
    });
    $('refresh-scores').addEventListener('click', () => { void this.operation(() => this.loadScores()); });
    this.update();
  }

  async request(path, body) {
    let response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(this.session.csrf ? { 'X-CSRF-Token': this.session.csrf } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (!(error instanceof TypeError || error?.name === 'AbortError')) throw error;
      throw new AccountError('api_unavailable');
    }
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new AccountError('api_unavailable', response.status);
    const result = await response.json();
    if (!response.ok) {
      if (result.error === 'authentication_required') this.setSession({ authenticated: false, user: null, csrf: null });
      throw new AccountError(result.error, response.status);
    }
    return result;
  }

  setSession(next) {
    if (!next || typeof next !== 'object' || typeof next.authenticated !== 'boolean' || (next.authenticated && (!isPublicHandle(next.user?.username) || typeof next.user.id !== 'string' || next.user.id.length !== 36 || !/^[a-f0-9-]{36}$/.test(next.user.id))) || (next.csrf !== null && (typeof next.csrf !== 'string' || next.csrf.length !== 43 || /[^A-Za-z0-9_-]/.test(next.csrf)))) throw new AccountError('api_unavailable');
    this.session = next;
    this.available = true;
    this.update();
    this.onChange(next);
  }

  async init() {
    try { this.setSession(await this.request('/api/session')); }
    catch (error) {
      if (!(error instanceof AccountError)) throw error;
      this.available = false;
      console.warn('Ranked account service is unavailable; casual flight remains enabled.');
      this.update();
    }
  }

  async bootstrap() {
    if (!this.supported) throw new AccountError('api_unavailable');
    this.setSession(await this.request('/api/auth/bootstrap', {}));
  }

  async signIn() {
    return this.operation(async () => {
      await this.bootstrap();
      const { options } = await this.request('/api/auth/login/options', {});
      const credential = await startAuthentication({ optionsJSON: options });
      this.setSession(await this.request('/api/auth/login/verify', { credential }));
      this.status('Signed in. Ranked flight is verified by the server; local and cheat scores cannot be imported.');
    });
  }

  update() {
    const signedIn = this.session.authenticated;
    $('account').textContent = signedIn ? this.session.user.username : 'TOP 10 / PILOT';
    $('signed-in').hidden = !signedIn;
    $('signed-out').hidden = signedIn;
    $('pilot-name').textContent = signedIn ? this.session.user.username : '';
    $('passkey-count').textContent = signedIn ? `${this.session.user.passkeys} / 5 passkeys` : '';
    $('passkey-unsupported').hidden = this.supported;
    for (const button of this.dialog.querySelectorAll('button:not(#identity-close)')) {
      button.disabled = this.busy || (!this.supported && button.id !== 'refresh-scores');
    }
    $('ranked').textContent = signedIn ? 'RANKED FLIGHT' : 'RANKED / SIGN IN';
  }

  status(message, error = false) {
    $('identity-status').textContent = message;
    $('identity-status').classList.toggle('is-error', error);
  }

  async operation(action) {
    if (this.busy) return false;
    this.busy = true;
    this.update();
    this.status('Working securely...');
    try { await action(); return true; }
    catch (error) {
      if (error instanceof AccountError) this.status(error.message, true);
      else if (['NotAllowedError', 'AbortError', 'InvalidStateError', 'NotSupportedError', 'SecurityError'].includes(error?.name) || error?.name === 'WebAuthnError') {
        this.status('The passkey request was cancelled or declined. Try again with a supported passkey for curl.red.', true);
      } else {
        console.error('An account operation failed unexpectedly; credential details were not logged.');
        this.status('The account operation failed. Reload before retrying; no unverified score was accepted.', true);
      }
      return false;
    } finally {
      this.busy = false;
      this.update();
    }
  }

  open() {
    this.onPause();
    if (!this.dialog.open) this.dialog.showModal();
    void this.operation(() => this.loadScores());
  }

  async loadScores() {
    const { entries } = await this.request('/api/leaderboard');
    if (!Array.isArray(entries) || entries.length > 10) throw new AccountError('api_unavailable');
    const rows = entries.map((entry, i) => {
      if (entry.rank !== i + 1 || !isPublicHandle(entry.username) || !Number.isSafeInteger(entry.score) || entry.score < 1) throw new AccountError('api_unavailable');
      const row = document.createElement('li');
      for (const text of [String(entry.rank).padStart(2, '0'), entry.username, entry.score.toLocaleString()]) {
        const span = document.createElement('span');
        span.textContent = text;
        row.append(span);
      }
      return row;
    });
    $('leaderboard-list').replaceChildren(...rows);
    $('leaderboard-empty').hidden = entries.length !== 0;
    this.status('Global top ten: one best verified score per account. Ties keep the earlier achievement.');
  }
}
