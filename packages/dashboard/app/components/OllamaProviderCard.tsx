import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { connectOllama, fetchOllamaStatus, refreshOllamaModels, updateOllamaConfig, type OllamaProviderStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./OllamaProviderCard.css";

interface OllamaProviderCardProps { onChanged?: () => void; }

/**
 * FNXC:OllamaProvider 2026-07-15-00:00:
 * Settings exposes this as one first-class native provider card, rather than a
 * generic API-key or OpenAI-compatible form. Every configuration/discovery
 * mutation refreshes model pickers because `ollama/<id>` identities can change.
 */
export function OllamaProviderCard({ onChanged }: OllamaProviderCardProps) {
  const [status, setStatus] = useState<OllamaProviderStatus | null>(null);
  const [endpoint, setEndpoint] = useState("http://localhost:11434");
  const [busy, setBusy] = useState<"connect" | "refresh" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchOllamaStatus();
      setStatus(next); setEndpoint(next.ollama.endpoint); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load Ollama status"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const mutate = useCallback(async (kind: NonNullable<typeof busy>, action: () => Promise<OllamaProviderStatus>) => {
    setBusy(kind); setError(null);
    try { const next = await action(); setStatus(next); setEndpoint(next.ollama.endpoint); onChanged?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Ollama request failed"); }
    finally { setBusy(null); }
  }, [onChanged]);

  const config = status?.ollama;
  return <section className="ollama-provider-card" data-testid="ollama-provider-card">
    <div className="ollama-provider-card__header"><div className="auth-provider-info"><ProviderIcon provider="ollama" size="sm" /><strong>Ollama — native API</strong></div>
      <label className="ollama-provider-card__enabled"><input aria-label="Enable Ollama" type="checkbox" checked={config?.enabled ?? false} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ enabled: event.target.checked }))} /> Enable</label>
    </div>
    <p className="auth-hint">Native <code>/api/*</code> connection; existing Custom Providers are unchanged.</p>
    <div className="ollama-provider-card__controls"><label>Endpoint<input aria-label="Ollama endpoint" value={endpoint} disabled={busy !== null} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <button className="btn btn-primary btn-sm" data-testid="ollama-connect" disabled={busy !== null} onClick={() => void mutate("connect", () => connectOllama({ endpoint }))}>{busy === "connect" ? <Loader2 size={12} className="animate-spin" /> : "Connect / Test"}</button>
      <button className="btn btn-sm" data-testid="ollama-refresh" disabled={busy !== null} onClick={() => void mutate("refresh", refreshOllamaModels)}>{busy === "refresh" ? "Refreshing…" : "Refresh models"}</button>
    </div>
    <div className="ollama-provider-card__controls"><label><input aria-label="Enable Ollama thinking" type="checkbox" checked={config?.think ?? false} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ think: event.target.checked }))} /> Think</label>
      <label>Context<input aria-label="Ollama context window" type="number" min="1024" value={config?.numCtx ?? 32768} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ numCtx: Number(event.target.value) }))} /></label>
      <label><input aria-label="Enable Ollama executor use" type="checkbox" checked={config?.executorEnabled ?? false} disabled={busy !== null} onChange={(event) => void mutate("save", () => updateOllamaConfig({ executorEnabled: event.target.checked }))} /> Enable executor use</label></div>
    <small className="auth-hint">Executor requires this opt-in and a model verified for tools.</small>
    {error && <small className="form-error" data-testid="ollama-error">{error}</small>}
    <div className="ollama-provider-card__models" data-testid="ollama-models">{config?.models.length ? config.models.map((model) => <span key={model.id}>{model.name} {model.toolCallingVerified ? "(tools verified)" : "(tools unverified)"}</span>) : "No discovered models"}</div>
  </section>;
}
