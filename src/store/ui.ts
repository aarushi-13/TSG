import { create } from 'zustand'

type UIState = { view: 'grid' | 'list'; setView: (view: 'grid' | 'list') => void }
export const useUIStore = create<UIState>((set) => ({ view: 'grid', setView: (view) => set({ view }) }))
