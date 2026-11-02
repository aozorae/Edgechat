declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: Record<string, unknown>): string;
      execute(widget: string): void;
      remove(widget: string): void;
    };
  }
}

let loading: Promise<void> | undefined;

export function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('turnstile_unavailable')); }, 15000);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('turnstile_unavailable')); };
      document.head.append(script);
    }).catch((error) => { loading = undefined; throw error; });
  }
  return loading;
}
