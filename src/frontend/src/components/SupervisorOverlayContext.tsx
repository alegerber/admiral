import { createContext, useContext } from 'react'

interface SupervisorOverlayValue {
  open: () => void
}

const SupervisorOverlayContext = createContext<SupervisorOverlayValue>({
  open: () => { /* noop default — overridden by provider */ },
})

export const SupervisorOverlayProvider = SupervisorOverlayContext.Provider
export const useSupervisorOverlay = () => useContext(SupervisorOverlayContext)
