import { useEffect, useState } from 'react'
import { Badge } from './ui/badge'
import { useSupervisorOverlay } from './SupervisorOverlayContext'

export function SupervisorBadge({ profileId }: { profileId: string }) {
  const [pendingCount, setPendingCount] = useState(0)
  const { open } = useSupervisorOverlay()

  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await fetch(`/api/supervisor/proposals?status=pending&profileId=${encodeURIComponent(profileId)}`)
        const data = await r.json() as { id: number }[]
        setPendingCount(data.length)
      } catch {
        // ignore
      }
    }
    refresh()
    const id = setInterval(refresh, 5_000)
    return () => clearInterval(id)
  }, [profileId])

  if (pendingCount === 0) return null

  return (
    <button onClick={open} className="cursor-pointer bg-transparent border-0 p-0">
      <Badge variant="destructive" className="cursor-pointer">
        ⚠ {pendingCount} supervisor proposal{pendingCount > 1 ? 's' : ''}
      </Badge>
    </button>
  )
}
