const ONBOARDING_KEY = 'dualReadOnboarding';

export interface OnboardingState {
  completed: boolean;
  completedAt?: number;
  /** Last chosen setup path for analytics-free UX restore. */
  path?: 'direct' | 'proxy' | 'server' | 'later';
}

const DEFAULT_STATE: OnboardingState = { completed: false };

export async function getOnboardingState(): Promise<OnboardingState> {
  try {
    const stored = await chrome.storage.local.get({ [ONBOARDING_KEY]: DEFAULT_STATE });
    const raw = stored[ONBOARDING_KEY] as OnboardingState;
    return {
      completed: Boolean(raw?.completed),
      completedAt: raw?.completedAt,
      path: raw?.path,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function setOnboardingState(patch: Partial<OnboardingState>): Promise<OnboardingState> {
  const current = await getOnboardingState();
  const next: OnboardingState = { ...current, ...patch };
  await chrome.storage.local.set({ [ONBOARDING_KEY]: next });
  return next;
}

export async function markOnboardingComplete(path?: OnboardingState['path']): Promise<void> {
  await setOnboardingState({
    completed: true,
    completedAt: Date.now(),
    path,
  });
}

export function openOnboardingPage(): void {
  const url = chrome.runtime.getURL('onboarding.html');
  void chrome.tabs.create({ url });
}
