import { createSlice } from './bridgeEngine';
import { create } from 'zustand';

export const useSidebarStore = create(() => ({ isOpen: false }));

export const sidebarSlice = createSlice('sidebar', {
  // Define actions and payloads implicitly inline
  TOGGLE_SIDEBAR: (payload: { forceState?: boolean }) => {
    useSidebarStore.setState((s) => ({ isOpen: payload.forceState ?? !s.isOpen }));
  },
  SET_SIDEBAR_WIDTH: (payload: { width: number }) => {
    // Local domestic UI updates go here
  }
});

import { createSlice } from './bridgeEngine';

export const themeSlice = createSlice('theme', {
  UPDATE_THEME: (payload: { mode: 'light' | 'dark'; primaryColor: string }) => {
    document.documentElement.setAttribute('data-theme', payload.mode);
  }
});

import { combineSlices } from './bridgeEngine';
import { sidebarSlice } from '../features/sidebar/sidebar.slice';
import { themeSlice } from '../features/theme/theme.slice';

// Just list them here. No manual type mapping required!
export const appBridge = combineSlices(sidebarSlice, themeSlice);

'use server';

import { appBridge } from './globalBridge';

export async function handleLogin() {
  // ... database query logic ...

  // Safe, autocomplete-driven, and perfectly mapped across your slices!
  return {
    success: true,
    signal: appBridge.send('UPDATE_THEME', {
      mode: 'dark',
      primaryColor: '#00ff00'
    })
  };
}
