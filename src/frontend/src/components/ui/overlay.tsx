import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface OverlayProps {
  title: string
  onClose: () => void
  children: ReactNode
  maxWidth?: string  // tailwind class, e.g. "max-w-[640px]" (default) or "max-w-[800px]"
  headerExtra?: ReactNode  // optional content placed next to the close button (e.g. step indicator)
  footer?: ReactNode  // optional sticky footer below the scrollable content
}

export function Overlay({ title, onClose, children, maxWidth = 'max-w-[640px]', headerExtra, footer }: OverlayProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className={`relative bg-card border border-border w-full ${maxWidth} max-h-[85vh] flex flex-col z-10`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between py-2.5 px-4 border-b border-border shrink-0">
          <h2 className="font-jetbrains text-sm font-medium text-primary tracking-[1.5px] uppercase">{title}</h2>
          <div className="flex items-center gap-3">
            {headerExtra}
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-border">{footer}</div>}
      </div>
    </div>
  )
}
