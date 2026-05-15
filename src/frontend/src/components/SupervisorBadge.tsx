import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from './ui/badge'

export function SupervisorBadge({ profileId }: { profileId: string }) {
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await fetch(`/api/supervisor/proposals?status=pending&profileId=${encodeURIComponent(profileId)}`)
        const data = await r.json() as { id: number }[]
        setPendingCount(data.length)
      } catch {
        // ignore — supervisor may be disabled or server offline
      }
    }
    refresh()
    const id = setInterval(refresh, 5_000)
    return () => clearInterval(id)
  }, [profileId])

  if (pendingCount === 0) return null

  return (
    <Link to="/supervisor">
      <Badge variant="destructive" className="cursor-pointer">
        ⚠ {pendingCount} supervisor proposal{pendingCount > 1 ? 's' : ''}
      </Badge>
    </Link>
  )
}
