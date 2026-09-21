import { create } from 'zustand'
import type { HorseState } from '../components/knowledge/HorseIcon'

// The assistant's status, lifted out of the chat page so the toolbar can show
// it while the user is elsewhere in the app. 'running' = a turn is in flight,
// 'error' = the last turn failed, 'idle' = resting/ready.
interface AssistantStore {
	status: HorseState
	setStatus: (status: HorseState) => void
}

export const useAssistantStore = create<AssistantStore>((set) => ({
	status: 'idle',
	setStatus: (status) => set({ status }),
}))
