export type BackgroundPreset = 'white' | 'mist' | 'sage' | 'sand' | 'sky' | 'lavender';

export const DEFAULT_BACKGROUND_PRESET: BackgroundPreset = 'white';

declare global {
  interface Window {
    __applyAiopsAppearance?: (theme: 'dark' | 'light', backgroundPreset: BackgroundPreset) => void;
  }
}

const LIGHT_BACKGROUND_COLORS: Record<BackgroundPreset, string> = {
  white: '#ffffff',
  mist: '#f5f7fb',
  sage: '#eef6ea',
  sand: '#f6f0e5',
  sky: '#edf5f8',
  lavender: '#f3eff9',
};

export function readInitialTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  try {
    const savedTheme = localStorage.getItem('aiops_theme');
    return savedTheme === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function readInitialBackgroundPreset(): BackgroundPreset {
  if (typeof window === 'undefined') return DEFAULT_BACKGROUND_PRESET;
  try {
    const savedPreset = localStorage.getItem('aiops_background_preset');
    if (
      savedPreset === 'mist' ||
      savedPreset === 'sage' ||
      savedPreset === 'sand' ||
      savedPreset === 'sky' ||
      savedPreset === 'lavender' ||
      savedPreset === 'white'
    ) {
      return savedPreset;
    }
  } catch {
    // ignore localStorage bootstrap errors
  }
  return DEFAULT_BACKGROUND_PRESET;
}

export function applyAppearance(theme: 'dark' | 'light', backgroundPreset: BackgroundPreset) {
  document.documentElement.classList.add('theme-transition');
  if (typeof window.__applyAiopsAppearance === 'function') {
    window.__applyAiopsAppearance(theme, backgroundPreset);
  } else {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-bg', backgroundPreset);
    const background = theme === 'light' ? LIGHT_BACKGROUND_COLORS[backgroundPreset] : '#0d0f12';
    document.documentElement.style.backgroundColor = background;
    if (document.body) {
      document.body.style.backgroundColor = background;
    }
  }
  localStorage.setItem('aiops_theme', theme);
  localStorage.setItem('aiops_background_preset', backgroundPreset);
  window.setTimeout(() => {
    document.documentElement.classList.remove('theme-transition');
  }, 360);
}
