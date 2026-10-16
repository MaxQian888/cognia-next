import { useEffect, useState } from "react"
import { Badge, Button, Input, Label, Switch } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { usePreferences } from "@ext/src/lib/panel/use-stored-value"
import { MAX_BLOCKED_HOSTS, normalizeHost } from "@ext/src/lib/preferences"

/**
 * The person's own settings for this browser (ADR-0228 §4, §8): system
 * notifications when the panel is closed, and sites the extension never
 * captures. Both live in `chrome.storage.local` as preferences, not content.
 */
export function ExtensionSettings({ api }: { api: BrowserApi }) {
  const [preferences, updatePreferences] = usePreferences(api)
  const [canNotify, setCanNotify] = useState(false)
  const [host, setHost] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .hasPermissions({ permissions: ["notifications"] })
      .then((granted) => {
        if (!cancelled) setCanNotify(granted)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  const toggleNotifications = async (next: boolean) => {
    setError(null)
    if (next) {
      // First in the click: the request must run inside the gesture.
      const granted = await api.requestPermissions({ permissions: ["notifications"] })
      setCanNotify(granted)
      if (!granted) {
        setError(api.message("notificationsDenied"))
        return
      }
    }
    await updatePreferences({ notifications: next })
  }

  const addHost = async () => {
    setError(null)
    const normalized = normalizeHost(host)
    if (!normalized) {
      setError(api.message("blockedHostInvalid"))
      return
    }
    if (preferences.blockedHosts.length >= MAX_BLOCKED_HOSTS) {
      setError(api.message("blockedHostFull"))
      return
    }
    if (!preferences.blockedHosts.includes(normalized)) {
      await updatePreferences({ blockedHosts: [...preferences.blockedHosts, normalized] })
    }
    setHost("")
  }

  return (
    <div className="space-y-2" data-testid="extension-settings">
      <div className="flex items-start justify-between gap-2">
        <Label htmlFor="cognia-notifications" className="flex-col items-start gap-0.5 text-xs">
          <span>{api.message("notificationsLabel")}</span>
          <span className="font-normal text-muted-foreground">
            {api.message("notificationsHint")}
          </span>
        </Label>
        <Switch
          id="cognia-notifications"
          checked={preferences.notifications && canNotify}
          onCheckedChange={(next) => void toggleNotifications(next)}
          data-testid="notifications-switch"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cognia-blocked-host" className="flex-col items-start gap-0.5 text-xs">
          <span>{api.message("blockedHostsLabel")}</span>
          <span className="font-normal text-muted-foreground">
            {api.message("blockedHostsHint")}
          </span>
        </Label>
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            void addHost()
          }}
        >
          <Input
            id="cognia-blocked-host"
            value={host}
            placeholder="bank.example.com"
            onChange={(event) => setHost(event.target.value)}
            data-testid="blocked-host-input"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!host.trim()}
            data-testid="blocked-host-add"
          >
            {api.message("blockedHostAdd")}
          </Button>
        </form>
        {preferences.blockedHosts.length > 0 ? (
          <ul className="flex flex-wrap gap-1" data-testid="blocked-hosts">
            {preferences.blockedHosts.map((blocked) => (
              <li key={blocked}>
                <Badge variant="outline" className="gap-1">
                  <span className="font-mono">{blocked}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={api.message("blockedHostRemove", [blocked])}
                    onClick={() =>
                      void updatePreferences({
                        blockedHosts: preferences.blockedHosts.filter((entry) => entry !== blocked),
                      })
                    }
                    data-testid={`blocked-host-remove-${blocked}`}
                  >
                    ×
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[11px] text-destructive" data-testid="settings-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
