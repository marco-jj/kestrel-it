import { Injectable, computed, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'kestrel_theme';

@Injectable({ providedIn: 'root' })
export class ThemeStore {
  readonly mode = signal<ThemeMode>(this.readInitialMode());
  readonly systemPrefersDark = signal<boolean>(this.readSystemPreference());

  readonly resolvedTheme = computed<'light' | 'dark'>(() => {
    const selected = this.mode();
    if (selected === 'system') {
      return this.systemPrefersDark() ? 'dark' : 'light';
    }
    return selected;
  });

  readonly isDark = computed<boolean>(() => this.resolvedTheme() === 'dark');

  constructor() {
    this.listenToSystemThemeChanges();
    this.applyToDom();
  }

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
    this.persistMode(mode);
    this.applyToDom();
  }

  toggleTheme(): void {
    const next: ThemeMode = this.resolvedTheme() === 'dark' ? 'light' : 'dark';
    this.setMode(next);
  }

  applyToDom(): void {
    if (typeof document === 'undefined' || !document.documentElement) {
      return;
    }
    const resolved = this.resolvedTheme();
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }

  private readInitialMode(): ThemeMode {
    if (typeof localStorage === 'undefined') {
      return 'light';
    }
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        return saved;
      }
    } catch {
      // Ignore storage access errors in restricted environments.
    }
    return 'light';
  }

  private readSystemPreference(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  }

  private persistMode(mode: ThemeMode): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Ignore storage write errors in restricted contexts.
    }
  }

  private listenToSystemThemeChanges(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', (event) => {
          this.systemPrefersDark.set(event.matches);
          if (this.mode() === 'system') {
            this.applyToDom();
          }
        });
      }
    } catch {
      // Ignore media listener failures in test environments.
    }
  }
}
