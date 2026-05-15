import { useState } from 'react'
import { KeyRound, Wifi, WifiOff, Search, Server } from 'lucide-react'
import type { Provider } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Overlay } from '@/components/ui/overlay'

const LOCALHOST = '127.0.0.1'

const DEFAULT_LOCAL_URLS: Record<string, string> = {
  ollama: `http://${LOCALHOST}:11434`,
  lmstudio: `http://${LOCALHOST}:1234`,
}

const PROVIDER_INFO: Record<string, { label: string; description: string; isLocal: boolean; keyPlaceholder: string }> = {
  anthropic: { label: 'Anthropic', description: 'Claude models', isLocal: false, keyPlaceholder: 'sk-ant-...' },
  openai: { label: 'OpenAI', description: 'GPT models', isLocal: false, keyPlaceholder: 'sk-...' },
  groq: { label: 'Groq', description: 'Fast inference', isLocal: false, keyPlaceholder: 'gsk_...' },
  google: { label: 'Google AI', description: 'Gemini models', isLocal: false, keyPlaceholder: 'AI...' },
  xai: { label: 'xAI', description: 'Grok models', isLocal: false, keyPlaceholder: 'xai-...' },
  mistral: { label: 'Mistral', description: 'Mistral models', isLocal: false, keyPlaceholder: '' },
  minimax: { label: 'MiniMax', description: 'MiniMax models', isLocal: false, keyPlaceholder: 'eyJ...' },
  nvidia: { label: 'NVIDIA NIM', description: 'NVIDIA hosted models', isLocal: false, keyPlaceholder: 'nvapi-...' },
  openrouter: { label: 'OpenRouter', description: 'Multi-provider gateway', isLocal: false, keyPlaceholder: 'sk-or-...' },
  ollama: { label: 'Ollama', description: 'Local models', isLocal: true, keyPlaceholder: '' },
  lmstudio: { label: 'LM Studio', description: 'Local models', isLocal: true, keyPlaceholder: '' },
  custom: { label: 'Custom', description: 'Any OpenAI-compatible endpoint', isLocal: true, keyPlaceholder: '' },
}

interface Props {
  providers: Provider[]
  registrationCode: string
  onRegistrationCodeChange: (code: string) => void
  gameserverUrl: string
  onGameserverUrlChange: (url: string) => void
  maxTurns: number
  onMaxTurnsChange: (turns: number) => void
  llmTimeout: number
  onLlmTimeoutChange: (seconds: number) => void
  onClose: () => void
}

export function ProviderSetup({ providers: initialProviders, registrationCode, onRegistrationCodeChange, gameserverUrl, onGameserverUrlChange, maxTurns, onMaxTurnsChange, llmTimeout, onLlmTimeoutChange, onClose }: Props) {
  const [providers, setProviders] = useState(initialProviders)
  const [keys, setKeys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const p of initialProviders) m[p.id] = p.api_key || ''
    return m
  })
  const [urls, setUrls] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const p of initialProviders) {
      if (DEFAULT_LOCAL_URLS[p.id]) {
        const stored = p.base_url?.replace(/\/v1\/?$/, '') || ''
        m[p.id] = stored || DEFAULT_LOCAL_URLS[p.id]
      } else if (p.id === 'custom') {
        m[p.id] = p.base_url?.replace(/\/v1\/?$/, '') || ''
      }
    }
    return m
  })
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [detecting, setDetecting] = useState(false)

  async function saveKey(id: string) {
    setSaving(s => ({ ...s, [id]: true }))
    try {
      const resp = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, api_key: keys[id] || '' }),
      })
      const result = await resp.json()
      setProviders(prev => prev.map(p => p.id === id ? { ...p, status: result.status, api_key: keys[id] || '' } : p))
    } finally {
      setSaving(s => ({ ...s, [id]: false }))
    }
  }

  async function saveLocalUrl(id: string) {
    setSaving(s => ({ ...s, [id]: true }))
    try {
      const baseUrl = (urls[id] || DEFAULT_LOCAL_URLS[id]).replace(/\/+$/, '') + '/v1'
      const resp = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, api_key: '', base_url: baseUrl }),
      })
      const result = await resp.json()
      setProviders(prev => prev.map(p => p.id === id ? { ...p, status: result.status, base_url: baseUrl } : p))
    } finally {
      setSaving(s => ({ ...s, [id]: false }))
    }
  }

  async function saveCustomProvider() {
    setSaving(s => ({ ...s, custom: true }))
    try {
      const raw = (urls['custom'] || '').replace(/\/+$/, '')
      const baseUrl = raw ? (raw.endsWith('/v1') ? raw : raw + '/v1') : ''
      const resp = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'custom', api_key: keys['custom'] || '', base_url: baseUrl }),
      })
      const result = await resp.json()
      setProviders(prev => prev.map(p => p.id === 'custom' ? { ...p, status: result.status, api_key: keys['custom'] || '', base_url: baseUrl } : p))
    } finally {
      setSaving(s => ({ ...s, custom: false }))
    }
  }

  async function detectLocal() {
    setDetecting(true)
    try {
      const customUrls: Record<string, string> = {}
      for (const [id, url] of Object.entries(urls)) {
        if (url && url !== DEFAULT_LOCAL_URLS[id]) {
          customUrls[id] = url.replace(/\/+$/, '')
        }
      }
      const resp = await fetch('/api/providers/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: customUrls }),
      })
      const results = await resp.json()
      setProviders(prev => {
        const updated = [...prev]
        for (const r of results as Array<{ id: string; status: string; baseUrl: string }>) {
          const idx = updated.findIndex(p => p.id === r.id)
          if (idx >= 0) updated[idx] = { ...updated[idx], status: r.status as Provider['status'], base_url: r.baseUrl }
        }
        return updated
      })
    } finally {
      setDetecting(false)
    }
  }

  return (
    <Overlay title="Settings" onClose={onClose}>
      {/* General section */}
      <div>
            <span className="text-[11px] text-[hsl(var(--smui-orange))] uppercase tracking-[1.5px] font-medium">General</span>
            <div className="space-y-2.5 mt-2.5">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Registration code</span>
                <Input
                  value={registrationCode}
                  onChange={e => onRegistrationCodeChange(e.target.value)}
                  placeholder="From spacemolt.com/dashboard"
                  className="flex-1 h-7 text-xs"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Gameserver URL</span>
                <Input
                  value={gameserverUrl}
                  onChange={e => onGameserverUrlChange(e.target.value)}
                  placeholder="https://game.spacemolt.com"
                  className="flex-1 h-7 text-xs"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Max agent turns</span>
                <Input
                  type="number"
                  value={maxTurns}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v > 0) onMaxTurnsChange(v)
                  }}
                  min={1}
                  max={200}
                  className="w-20 h-7 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">tool rounds per LLM turn</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">LLM timeout</span>
                <Input
                  type="number"
                  value={llmTimeout}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v > 0) onLlmTimeoutChange(v)
                  }}
                  min={30}
                  max={600}
                  className="w-20 h-7 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">seconds per LLM call</span>
              </div>
            </div>
          </div>

          {/* Providers section */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] text-[hsl(var(--smui-frost-2))] uppercase tracking-[1.5px] font-medium">Providers</span>
              <Button
                variant="outline"
                size="sm"
                onClick={detectLocal}
                disabled={detecting}
                className="gap-1.5 h-6 text-[10px] hover:text-primary hover:border-primary/40"
              >
                <Search size={11} />
                {detecting ? 'Scanning...' : 'Detect Local'}
              </Button>
            </div>
            <div className="space-y-1.5">
              {providers.map(p => {
                const info = PROVIDER_INFO[p.id] || { label: p.id, description: '', isLocal: false, keyPlaceholder: '' }
                return (
                  <div key={p.id} className="border border-border/60 bg-background/30 px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <div className={`status-dot ${
                        p.status === 'valid' ? 'status-dot-green' :
                        p.status === 'invalid' ? 'status-dot-red' :
                        p.status === 'unreachable' ? 'status-dot-orange' :
                        'status-dot-grey'
                      }`} />
                      <span className="text-xs font-medium text-foreground">{info.label}</span>
                      <span className="text-[10px] text-muted-foreground">{info.description}</span>
                    </div>

                    {p.id === 'custom' ? (
                      <>
                        <div className="flex items-center gap-2 mt-2 ml-4">
                          <Server size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            value={urls['custom'] || ''}
                            onChange={e => setUrls(u => ({ ...u, custom: e.target.value }))}
                            placeholder="http://host:port/v1"
                            className="flex-1 h-6 text-[11px]"
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 ml-4">
                          <KeyRound size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            type="password"
                            value={keys['custom'] || ''}
                            onChange={e => setKeys(k => ({ ...k, custom: e.target.value }))}
                            placeholder="API key (optional)"
                            className="flex-1 h-6 text-[11px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={saveCustomProvider}
                            disabled={saving['custom']}
                            className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                          >
                            {saving['custom'] ? '...' : 'Save'}
                          </Button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 ml-4">
                          {p.status === 'valid' ? (
                            <><Wifi size={10} className="text-[hsl(var(--smui-green))]" /><span className="text-[10px] text-[hsl(var(--smui-green))]">Reachable</span></>
                          ) : p.status === 'unreachable' ? (
                            <><WifiOff size={10} className="text-[hsl(var(--smui-orange))]" /><span className="text-[10px] text-[hsl(var(--smui-orange))]">Unreachable</span></>
                          ) : urls['custom'] ? (
                            <><WifiOff size={10} className="text-muted-foreground" /><span className="text-[10px] text-muted-foreground">Not tested</span></>
                          ) : null}
                        </div>
                      </>
                    ) : !info.isLocal ? (
                      <div className="flex items-center gap-2 mt-2 ml-4">
                        <KeyRound size={10} className="text-muted-foreground shrink-0" />
                        <Input
                          type="password"
                          value={keys[p.id] || ''}
                          onChange={e => setKeys(k => ({ ...k, [p.id]: e.target.value }))}
                          placeholder={info.keyPlaceholder || 'API key'}
                          className="flex-1 h-6 text-[11px]"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => saveKey(p.id)}
                          disabled={saving[p.id]}
                          className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                        >
                          {saving[p.id] ? '...' : 'Save'}
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mt-2 ml-4">
                          <Server size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            value={urls[p.id] || DEFAULT_LOCAL_URLS[p.id] || ''}
                            onChange={e => setUrls(u => ({ ...u, [p.id]: e.target.value }))}
                            placeholder={DEFAULT_LOCAL_URLS[p.id] || 'http://host:port'}
                            className="flex-1 h-6 text-[11px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => saveLocalUrl(p.id)}
                            disabled={saving[p.id]}
                            className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                          >
                            {saving[p.id] ? '...' : 'Save'}
                          </Button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 ml-4">
                          {p.status === 'valid' ? (
                            <><Wifi size={10} className="text-[hsl(var(--smui-green))]" /><span className="text-[10px] text-[hsl(var(--smui-green))]">Running</span></>
                          ) : (
                            <><WifiOff size={10} className="text-muted-foreground" /><span className="text-[10px] text-muted-foreground">Not detected</span></>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
    </Overlay>
  )
}
