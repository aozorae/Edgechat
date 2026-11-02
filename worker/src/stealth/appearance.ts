// These choices describe presentation only. Never use them for authentication or routing.
export const appearanceOptions = {
  layout: 3, heading: 3, fields: 3, actions: 3, notice: 3,
  palette: 4, typography: 3, shape: 3, density: 3, wording: 4, names: 4, order: 6,
} as const;

export type GateAppearance = { version: 1; usernameId: string; passwordId: string; width: number; top: number }
  & { [Key in keyof typeof appearanceOptions]: number };

export function createGateAppearance(): GateAppearance {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const choices = Object.fromEntries(Object.entries(appearanceOptions).map(([key, count], index) => [key, bytes[index] % count]));
  const id = (start: number) => btoa(String.fromCharCode(...bytes.slice(start, start + 9))).replace(/\+/g, '-').replace(/\//g, '_');
  return {
    ...choices, version: 1, usernameId: id(14), passwordId: id(23),
    width: 304 + bytes[12] % 81, top: 8 + bytes[13] % 19,
  } as GateAppearance;
}

export function isGateAppearance(value: unknown): value is GateAppearance {
  if (!value || typeof value !== 'object') return false;
  const profile = value as GateAppearance;
  return profile.version === 1
    && Object.entries(appearanceOptions).every(([key, count]) => Number.isInteger(profile[key]) && profile[key] >= 0 && profile[key] < count)
    && Number.isInteger(profile.width) && profile.width >= 304 && profile.width <= 384
    && Number.isInteger(profile.top) && profile.top >= 8 && profile.top <= 26
    && /^[A-Za-z0-9_-]{12}$/.test(profile.usernameId) && /^[A-Za-z0-9_-]{12}$/.test(profile.passwordId)
    && profile.usernameId !== profile.passwordId;
}

const wording = [
  { title: 'Sign in', user: 'Username', password: 'Password', button: 'Sign in', error: 'Unable to sign in. Please try again.' },
  { title: 'Log in', user: 'User name', password: 'Password', button: 'Log in', error: 'Login failed. Please try again.' },
  { title: 'Account access', user: 'Username', password: 'Password', button: 'Continue', error: 'Unable to continue. Check your credentials.' },
  { title: 'Welcome', user: 'User name', password: 'Password', button: 'Continue', error: 'Unable to sign in. Please try again.' },
];
const palettes = [
  { background: '#f5f5f5', surface: '#fff', text: '#222', border: '#888', accent: '#333' },
  { background: '#fff', surface: '#fff', text: '#242424', border: '#999', accent: '#385873' },
  { background: '#f6f5f2', surface: '#fffefa', text: '#302d29', border: '#918b80', accent: '#51483c' },
  { background: '#f3f5f4', surface: '#fff', text: '#28302d', border: '#89958f', accent: '#37564a' },
];
const classNames = [
  ['panel', 'field', 'actions', 'notice'], ['card', 'control', 'buttons', 'message'],
  ['box', 'row', 'submit', 'status'], ['content', 'entry', 'footer', 'feedback'],
];

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function renderGate(settings: { loginPath: string; formId: string; appearance: GateAppearance }, failed: boolean, siteKey = '', nonce = '') {
  const a = settings.appearance;
  const text = wording[a.wording];
  const color = palettes[a.palette];
  const [panel, field, actions, notice] = classNames[a.names];
  const gap = [12, 16, 20][a.density];
  const radius = [0, 4, 8][a.shape];
  const font = ['system-ui,sans-serif', 'Arial,Helvetica,sans-serif', 'Verdana,sans-serif'][a.typography];

  const heading = [
    `<h1>${text.title}</h1>`,
    `<header><h1>${text.title}</h1></header>`,
    `<header><h1><span>${text.title}</span></h1></header>`,
  ][a.heading];
  const input = (password: boolean) => `<input id="${password ? a.passwordId : a.usernameId}"${password ? ' type="password"' : ''} name="${password ? 'password' : 'username'}" autocomplete="${password ? 'current-password' : 'username'}" maxlength="${password ? 1024 : 100}" required>`;
  const row = (password: boolean) => {
    const label = password ? text.password : text.user;
    const id = password ? a.passwordId : a.usernameId;
    return [
      `<label class="${field}">${label}${input(password)}</label>`,
      `<div class="${field}"><label for="${id}">${label}</label>${input(password)}</div>`,
      `<div class="${field}">${input(password)}<label for="${id}">${label}</label></div>`,
    ][a.fields];
  };
  const button = `<button type="submit">${text.button}</button>`;
  const action = [button, `<div class="${actions}">${button}</div>`, `<footer class="${actions}">${button}</footer>`][a.actions];
  const message = failed ? [
    `<p class="${notice}" role="alert">${text.error}</p>`,
    `<div class="${notice}" role="alert"><p>${text.error}</p></div>`,
    `<aside class="${notice}" role="alert">${text.error}</aside>`,
  ][a.notice] : '';
  const verification = siteKey ? `<div id="verification" data-sitekey="${escapeHtml(siteKey)}"></div><p id="verification-error" role="alert" hidden>Verification failed. Please try again.</p>` : '';
  const form = `<form action="${escapeHtml(settings.loginPath)}" method="post">${row(false)}${row(true)}${verification}${action}</form>`;
  const content = heading + form + message;
  const body = [
    `<main id="${escapeHtml(settings.formId)}" class="${panel}">${content}</main>`,
    `<main><section id="${escapeHtml(settings.formId)}" class="${panel}" aria-label="${text.title}">${content}</section></main>`,
    `<main><div id="${escapeHtml(settings.formId)}" class="${panel}">${content}</div></main>`,
  ][a.layout];
  const styles = [
    `html{font:16px/1.5 ${font};background:${color.background};color:${color.text}}body{margin:0;padding:24px}`,
    `.${panel}{box-sizing:border-box;max-width:${a.width}px;margin:${a.top}vh auto 24px;${a.layout === 0 ? '' : `padding:${gap + 8}px;background:${color.surface};border:1px solid ${color.border};border-radius:${radius}px;`}}`,
    `h1{font-size:${[24, 22, 26][a.heading]}px;font-weight:600;margin:0 0 ${gap + 8}px}${a.heading === 1 ? `header{border-bottom:1px solid ${color.border};margin-bottom:${gap}px}` : ''}`,
    `form{display:grid;gap:${gap}px}.${field}{display:${a.fields === 2 ? 'flex;flex-direction:column-reverse' : 'grid'};gap:6px}input,button{box-sizing:border-box;width:100%;min-height:44px;font:inherit;border:1px solid ${color.border};border-radius:${radius}px;padding:8px 12px}input{background:${color.surface};color:${color.text};min-width:0}`,
    `button{cursor:pointer;${a.actions === 2 ? `background:${color.accent};color:#fff` : `background:${color.surface};color:${color.text}`}}${a.actions === 0 ? `button{margin-top:8px}` : `.${actions}{padding-top:8px;${a.actions === 1 ? 'display:flex;justify-content:flex-end}button{width:auto;min-width:110px' : ''}}`}`,
    `input:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:3px}.${notice}{font-size:14px;margin:${gap}px 0 0}.${notice} p{margin:0}@media(max-width:420px){body{padding:16px}.${panel}{margin-top:8vh}}`,
  ];
  // Emit only selected templates. The saved order also avoids a single fixed style-block prefix.
  const css = [...styles.slice(a.order), ...styles.slice(0, a.order)].join('\n');
  // 仅启用验证时加载外部脚本；每次提交后才执行挑战，不预先获取并复用 token。
  const script = siteKey ? `<script nonce="${nonce}">
    const form = document.querySelector('form');
    const button = form.querySelector('button');
    const container = document.getElementById('verification');
    const error = document.getElementById('verification-error');
    let widget;
    window.onGateTurnstile = () => { button.disabled = false; };
    button.disabled = true;
    setTimeout(() => { if (!window.turnstile) { button.disabled = false; error.hidden = false; } }, 15000);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (button.disabled) return;
      if (!window.turnstile) { error.hidden = false; return; }
      button.disabled = true;
      error.hidden = true;
      if (widget !== undefined) turnstile.remove(widget);
      const failed = () => { button.disabled = false; error.hidden = false; };
      widget = turnstile.render(container, {
        sitekey: container.dataset.sitekey, action: 'login', execution: 'execute', size: 'compact', retry: 'never',
        callback: () => form.submit(), 'error-callback': failed, 'expired-callback': failed, 'timeout-callback': failed
      });
      turnstile.execute(widget);
    });
  </script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&amp;onload=onGateTurnstile" async defer></script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text.title}</title><style>${css}</style></head><body>${body}${script}</body></html>`;
}
