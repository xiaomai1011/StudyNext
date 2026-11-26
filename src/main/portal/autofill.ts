/**
 * Builds the script that fills the official Chaoxing passport form. The
 * password only travels from the main process into the page that the user is
 * already looking at; it is never written to disk, logs, or renderer state.
 */
export function buildCredentialFillScript(username: string, password: string): string {
  const payload = JSON.stringify({ username, password })
  return `(() => {
  const data = ${payload};
  const setValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor || typeof descriptor.set !== 'function') return false;
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const usernameInput = document.querySelector(
    'input#phone, input[name="uname"], input[name="phone"], input[name="username"], input[type="tel"]'
  );
  const passwordInput = document.querySelector(
    'input#pwd, input[name="password"], input[name="passwd"], input[type="password"]'
  );
  if (!usernameInput || !passwordInput) return false;
  if (!(usernameInput instanceof HTMLInputElement) || !(passwordInput instanceof HTMLInputElement)) {
    return false;
  }
  const userFilled = setValue(usernameInput, data.username);
  const passwordFilled = setValue(passwordInput, data.password);
  return userFilled && passwordFilled;
})()`
}

export function buildCredentialLoginScript(username: string, password: string): string {
  const payload = JSON.stringify({ username, password })
  return `(() => {
  const data = ${payload};
  const setValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor || typeof descriptor.set !== 'function') return false;
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const usernameInput = document.querySelector(
    'input#phone, input[name="uname"], input[name="phone"], input[name="username"], input[type="tel"]'
  );
  const passwordInput = document.querySelector(
    'input#pwd, input[name="password"], input[name="passwd"], input[type="password"]'
  );
  if (!usernameInput || !passwordInput) return false;
  if (!(usernameInput instanceof HTMLInputElement) || !(passwordInput instanceof HTMLInputElement)) {
    return false;
  }
  if (!setValue(usernameInput, data.username) || !setValue(passwordInput, data.password)) return false;
  const loginButton = document.querySelector(
    '#loginBtn, button#loginBtn, input#loginBtn, a#loginBtn, button[name="loginBtn"], button[type="submit"], .btn-big-blue'
  );
  if (!(loginButton instanceof HTMLElement)) return false;
  loginButton.click();
  return true;
})()`
}

export function buildLoginErrorScript(): string {
  return `(() => {
  const nodes = document.querySelectorAll('#err-txt, #phoneMsg, #pwdMsg, .err-tip, .err-txt');
  for (const node of nodes) {
    const text = (node.textContent || '').trim();
    if (text) return text;
  }
  return '';
})()`
}

export function isChaoxingLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== 'chaoxing.com' && !hostname.endsWith('.chaoxing.com')) return false
    return hostname.startsWith('passport') || /(^|\/)(login|signin)(\/|$)/i.test(parsed.pathname)
  } catch {
    return false
  }
}
