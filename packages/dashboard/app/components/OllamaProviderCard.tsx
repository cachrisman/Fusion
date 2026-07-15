import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { connectOllama, fetchOllamaStatus, refreshOllamaModels, updateOllamaConfig, updateOllamaEndpointAuth, type OllamaProviderStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./OllamaProviderCard.css";

interface OllamaProviderCardProps {
  /** `undefined` keeps the component independently usable; Settings passes null while status is probing. */
  status?: OllamaProviderStatus | null;
  onStatusChanged?: (status: OllamaProviderStatus) => void;
  onChanged?: () => void;
}

/**
 * FNXC:OllamaAvailability 2026-07-15-00:00:
 * The native card follows compact provider-card layout so its placement is controlled by the
 * redacted native `enabled` setting, not the generic `ollama` SDK placeholder. A disabled local
 * endpoint stays discoverable in Available, and Enable persists only after native Connect succeeds.
 * Optional protected-endpoint tokens remain write-only, endpoint-bound auth-storage data.
 */
export function OllamaProviderCard({ status: controlledStatus, onStatusChanged, onChanged }: OllamaProviderCardProps) {
  const [localStatus, setLocalStatus] = useState<OllamaProviderStatus | null>(null);
  const [endpoint, setEndpoint] = useState("http://localhost:11434");
  const [endpointAuthToken, setEndpointAuthToken] = useState("");
  const [showEndpointAuthInput, setShowEndpointAuthInput] = useState(false);
  const [busy, setBusy] = useState<"connect" | "enable" | "disable" | "refresh" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasControlledStatus = controlledStatus !== undefined;
  const status = hasControlledStatus ? controlledStatus : localStatus;

  const load = useCallback(async () => {
    try {
      const next = await fetchOllamaStatus();
      setLocalStatus(next);
      setEndpoint(next.ollama.endpoint);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load Ollama status");
    }
  }, []);

  useEffect(() => {
    if (hasControlledStatus) {
      setEndpoint(controlledStatus?.ollama.endpoint ?? "http://localhost:11434");
      return;
    }
    void load();
  }, [controlledStatus, hasControlledStatus, load]);

  const publishStatus = useCallback((next: OllamaProviderStatus) => {
    if (!hasControlledStatus) setLocalStatus(next);
    setEndpoint(next.ollama.endpoint);
    onStatusChanged?.(next);
    onChanged?.();
  }, [hasControlledStatus, onChanged, onStatusChanged]);

  const mutate = useCallback(async (kind: NonNullable<typeof busy>, action: () => Promise<OllamaProviderStatus>) => {
    setBusy(kind);
    setError(null);
    try {
      publishStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ollama request failed");
    } finally {
      setBusy(null);
    }
  }, [publishStatus]);

  const config = status?.ollama;
  const endpointAvailable = status?.availability.available === true;
  const enabled = config?.enabled === true;
  const configuredEndpoint = config?.endpoint ?? endpoint;
  const statusText = !status
    ? `Probing ${configuredEndpoint}…`
    : !endpointAvailable
      ? `${configuredEndpoint} — ${status.availability.reason}`
      : enabled
        ? `${configuredEndpoint} — Connected`
        : `${configuredEndpoint} — Detected. Click Enable to use native Ollama.`;

  const saveEndpointAuth = () => {
    const token = endpointAuthToken.trim();
    if (!token) {
      setError("Enter a token for the protected endpoint");
      return;
    }
    setEndpointAuthToken("");
    setShowEndpointAuthInput(false);
    // FNXC:OllamaEndpointAuth 2026-07-15-19:27: Bind the token to the typed endpoint so a new protected endpoint can be probed on the next Test.
    void mutate("save", () => updateOllamaEndpointAuth(token, endpoint));
  };

  const actions = <div className="auth-provider-cli-actions ollama-provider-card__actions">
    <button type="button" className="btn btn-sm" data-testid="ollama-connect" disabled={busy !== null} onClick={() => void mutate("connect", () => connectOllama({ endpoint }))}>
      {busy === "connect" ? <><Loader2 size={12} className="animate-spin" /> Testing…</> : "Test"}
    </button>
    {enabled ? (
      <button type="button" className="btn btn-sm" data-testid="ollama-disable" disabled={busy !== null} onClick={() => void mutate("disable", () => updateOllamaConfig({ enabled: false }))}>
        {busy === "disable" ? "Disabling…" : "Disable"}
      </button>
    ) : (
      <button type="button" className="btn btn-primary btn-sm" data-testid="ollama-enable" disabled={busy !== null || !endpointAvailable} onClick={() => void mutate("enable", () => connectOllama({ endpoint, enabled: true }))}>
        {busy === "enable" ? "Enabling…" : "Enable"}
      </button>
    )}
  </div>;

  return <div className={`ollama-provider-card auth-provider-card auth-provider-card--cli${enabled ? " auth-provider-card--authenticated" : ""}`} data-testid="ollama-provider-card">
    <div className="auth-provider-header">
      <div className="auth-provider-info">
        <ProviderIcon provider="ollama" size="sm" />
        <strong>Ollama — native API</strong>
        <span className={`auth-status-badge ${enabled ? "authenticated" : "not-authenticated"}`}>{enabled ? "✓ Active" : "✗ Not connected"}</span>
      </div>
      {actions}
    </div>
    <div className="ollama-provider-card__body" data-testid="ollama-provider-card-body">
      <small className="settings-muted" role="status">{statusText}</small>
      <div className="ollama-provider-card__controls">
        <label>Endpoint<input className="input" aria-label="Ollama endpoint" value={endpoint} disabled={busy !== null} onChange={(event) => setEndpoint(event.target.value)} /></label>
        <button type="button" className="btn btn-sm" data-testid="ollama-refresh" disabled={busy !== null} onClick={() => void mutate("refresh", refreshOllamaModels)}>{busy === "refresh" ? "Refreshing…" : "Refresh models"}</button>
      </div>
      <div className="ollama-provider-card__endpoint-auth" data-testid="ollama-endpoint-auth">
        <div><strong>Endpoint authentication (optional)</strong><small className="auth-hint">For protected or reverse-proxy endpoints only.</small></div>
        {status?.endpointAuthConfigured ? <><span data-testid="ollama-endpoint-auth-configured">Configured</span><button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void mutate("save", () => updateOllamaEndpointAuth(null))}>Clear endpoint token</button><button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setShowEndpointAuthInput((current) => !current)}>Replace token</button></> : <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setShowEndpointAuthInput((current) => !current)}>{showEndpointAuthInput ? "Cancel" : "Add endpoint token"}</button>}
      </div>
      {showEndpointAuthInput && <div className="ollama-provider-card__endpoint-auth-input"><label>Endpoint token<input className="input" aria-label="Optional Ollama endpoint token" type="password" autoComplete="new-password" value={endpointAuthToken} disabled={busy !== null} onChange={(event) => setEndpointAuthToken(event.target.value)} /></label><button type="button" className="btn btn-primary btn-sm" data-testid="ollama-save-endpoint-auth" disabled={busy !== null || !endpointAuthToken.trim()} onClick={saveEndpointAuth}>Save endpoint token</button></div>}
      <div className="ollama-provider-card__controls"><label><input aria-label="Enable Ollama thinking" type="checkbox" checked={config?.think ?? false} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ think: event.target.checked }))} /> Think</label>
        <label>Context<input className="input" aria-label="Ollama context window" type="number" min="1024" value={config?.numCtx ?? 32768} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ numCtx: Number(event.target.value) }))} /></label>
        <label><input aria-label="Enable Ollama executor use" type="checkbox" checked={config?.executorEnabled ?? false} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ executorEnabled: event.target.checked }))} /> Enable executor use</label></div>
      <small className="auth-hint">Executor requires this opt-in and a model verified for tools.</small>
      {error && <small className="form-error" data-testid="ollama-error">{error}</small>}
      <div className="ollama-provider-card__models" data-testid="ollama-models">{config?.models.length ? config.models.map((model) => <span key={model.id}>{model.name} {model.toolCallingVerified ? "(tools verified)" : "(tools unverified)"}</span>) : "No discovered models"}</div>
    </div>
  </div>;
}
