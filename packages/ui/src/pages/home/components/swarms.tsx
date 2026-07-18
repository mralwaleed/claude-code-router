import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SwarmAgentDto, SwarmDiagnosticsDto, SwarmProfileDto, SwarmSessionDto } from "@ccr/core/swarm/api";
import type { GatewayProviderConfig } from "@ccr/core/contracts/app";

type SwarmViewMode = "list" | "create" | "detail";

export function SwarmsView() {
  const [mode, setMode] = useState<SwarmViewMode>("list");
  const [swarms, setSwarms] = useState<SwarmProfileDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agents, setAgents] = useState<SwarmAgentDto[]>([]);
  const [sessions, setSessions] = useState<SwarmSessionDto[]>([]);
  const [diagnostics, setDiagnostics] = useState<SwarmDiagnosticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<GatewayProviderConfig[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const refreshList = useCallback(async () => {
    try {
      setError(null);
      setSwarms(await window.ccr!.swarmList());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const [ag, sess, diag] = await Promise.all([
        window.ccr!.swarmRegistrySnapshot(id),
        window.ccr!.swarmSessions(id),
        window.ccr!.swarmDiagnostics(id)
      ]);
      setAgents(ag);
      setSessions(sess);
      setDiagnostics(diag);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refreshList();
    window.ccr!.getConfig().then((c) => setProviders(c.Providers ?? [])).catch(() => {});
  }, [refreshList]);

  // modest polling for sessions when viewing a detail
  useEffect(() => {
    if (mode === "detail" && selectedId) {
      refreshDetail(selectedId);
      pollRef.current = setInterval(() => refreshDetail(selectedId), 10000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [mode, selectedId, refreshDetail]);

  // ---- Actions ----
  const openSwarm = (id: string) => { setSelectedId(id); setMode("detail"); setError(null); };
  const backToList = () => { setMode("list"); setSelectedId(null); setAgents([]); setSessions([]); setDiagnostics(null); };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    setBusy(true);
    try { await window.ccr!.swarmSetEnabled(id, enabled); await refreshList(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const launchSwarm = async (id: string) => {
    setBusy(true);
    try {
      const result = await window.ccr!.swarmLaunch(id);
      if (!result.ok) { setError(result.error ?? "Launch failed"); return; }
      await refreshList();
      if (selectedId === id) await refreshDetail(id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const stopSession = async (sessionId: string) => {
    setBusy(true);
    try { await window.ccr!.swarmStop(sessionId); if (selectedId) await refreshDetail(selectedId); await refreshList(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const deleteSwarm = async (id: string) => {
    if (!confirm("Delete this Swarm? This cannot be undone.")) return;
    setBusy(true);
    try {
      const result = await window.ccr!.swarmDelete(id);
      if (!result.ok) { setError(result.error ?? "Cannot delete"); return; }
      await refreshList();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const rescanSwarm = async (id: string) => {
    setBusy(true);
    try { setAgents(await window.ccr!.swarmScan(id)); if (selectedId) await refreshDetail(selectedId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  // ---- Render ----
  if (error) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-medium">Error</p>
          <p className="mt-1">{error}</p>
          <Button className="mt-3" onClick={() => { setError(null); refreshList(); }} size="sm" variant="secondary">Retry</Button>
        </div>
      </div>
    );
  }

  if (mode === "create") {
    return <SwarmForm providers={providers} onSave={async (input) => {
      setBusy(true);
      try { await window.ccr!.swarmCreate(input); backToList(); await refreshList(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }} onCancel={backToList} busy={busy} />;
  }

  if (mode === "detail" && selectedId) {
    const profile = swarms.find((s) => s.id === selectedId);
    if (!profile) { backToList(); return null; }
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-center gap-3">
          <Button onClick={backToList} size="sm" variant="ghost">← Back</Button>
          <h2 className="text-lg font-semibold">{profile.name}</h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${profile.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{profile.enabled ? "Enabled" : "Disabled"}</span>
        </div>

        {/* Agent Registry */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold">Agent Registry ({agents.length})</h3>
            <Button onClick={() => rescanSwarm(profile.id)} disabled={busy} size="sm" variant="secondary">Rescan</Button>
          </div>
          {agents.length === 0 ? (
            <p className="text-xs text-muted-foreground">No agents discovered. Check agent directories + rescan.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {["Agent", "Slug", "Status", "Provider/Model", "Fingerprint", "Modified"].map((h) => (
                      <th key={h} className="px-2 py-1.5 text-left font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id} className="border-t border-border/50">
                      <td className="px-2 py-1.5 font-medium">{a.displayName}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{a.slug}</td>
                      <td className="px-2 py-1.5">
                        <span className={a.validationStatus === "ok" ? "text-emerald-600" : a.validationStatus === "degraded" ? "text-amber-600" : "text-destructive"}>{a.validationStatus}</span>
                        {a.validationErrors.length > 0 && <span className="ml-1 text-muted-foreground" title={a.validationErrors.join("; }")}>⚠</span>}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{a.providerOverrideId}/{a.modelOverride || "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-muted-foreground">{a.bodyHashPrefix || "—"}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{a.lastModifiedAt ? new Date(a.lastModifiedAt).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Sessions */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">Active Sessions ({sessions.length})</h3>
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active sessions.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-md border border-border p-2 text-xs">
                  <span className="font-mono text-muted-foreground">{s.id.slice(0, 12)}…</span>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600">{s.status}</span>
                  <span className="text-muted-foreground">{s.launcherType}</span>
                  <span className="text-muted-foreground">{s.claudeSessionId ? "bound" : "unbound"}</span>
                  <Button onClick={() => stopSession(s.id)} disabled={busy} size="sm" variant="destructive">Stop</Button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Diagnostics */}
        {diagnostics && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Diagnostics</h3>
            <div className="rounded-md border border-border p-3 text-xs">
              {diagnostics.profileErrors.length > 0 && (
                <div className="mb-2 text-destructive">Errors: {diagnostics.profileErrors.join("; ")}</div>
              )}
              {diagnostics.profileWarnings.length > 0 && (
                <div className="mb-2 text-amber-600">Warnings: {diagnostics.profileWarnings.join("; ")}</div>
              )}
              <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                <span>Registry generation: <span className="font-mono">{diagnostics.registryGeneration}</span></span>
                <span>Watcher: <span className="font-mono">{diagnostics.watcherStatus}</span></span>
                <span>Active sessions: {diagnostics.activeSessionCount}</span>
                <span>Agent issues: {diagnostics.agentErrors.length}</span>
              </div>
              {diagnostics.recentAttributions.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium">Recent routing:</p>
                  {diagnostics.recentAttributions.slice(0, 5).map((a) => (
                    <div key={a.requestId} className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {a.classification} [{a.attributionMethod}]{a.detectorVersion ? ` (${a.detectorVersion})` : ""} → {a.routingReason} → {a.selectedProviderId}/{a.selectedModel || "—"}{a.fallbackReason ? ` [fallback: ${a.fallbackReason}]` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        <div className="flex gap-2">
          <Button onClick={() => launchSwarm(profile.id)} disabled={busy || !profile.enabled} size="sm">Launch</Button>
          <Button onClick={() => toggleEnabled(profile.id, !profile.enabled)} disabled={busy} size="sm" variant="secondary">{profile.enabled ? "Disable" : "Enable"}</Button>
        </div>
      </div>
    );
  }

  // List mode
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Swarms</h2>
        <Button onClick={() => setMode("create")} size="sm">+ Create</Button>
      </div>
      {swarms.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No Swarms configured.</p>
            <p className="mt-1 text-xs text-muted-foreground">Create a Swarm to manage per-project agent orchestration.</p>
            <Button onClick={() => setMode("create")} className="mt-4" size="sm">Create Swarm</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {swarms.map((s) => (
            <div key={s.id} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{s.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${s.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{s.enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Leader: {s.leaderProviderId}/{s.leaderModel || "—"}</span>
                    <span>Default: {s.defaultProviderId}/{s.defaultModel || "—"}</span>
                    <span>Roots: {s.workspaceRoots.length}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button onClick={() => openSwarm(s.id)} size="sm" variant="ghost">Open</Button>
                  <Button onClick={() => launchSwarm(s.id)} disabled={busy || !s.enabled} size="sm" variant="secondary">Launch</Button>
                  <Button onClick={() => toggleEnabled(s.id, !s.enabled)} disabled={busy} size="sm" variant="ghost">{s.enabled ? "Disable" : "Enable"}</Button>
                  <Button onClick={() => deleteSwarm(s.id)} disabled={busy} size="sm" variant="ghost">Delete</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Create/Edit Form ----
type SwarmDraft = {
  name: string;
  description: string;
  enabled: boolean;
  workspaceRoots: string;
  launchDirectory: string;
  agentDirectories: string;
  leaderProviderId: string;
  leaderModel: string;
  defaultProviderId: string;
  defaultModel: string;
  fallbackProviderId: string;
  fallbackModel: string;
  watchFiles: boolean;
  autoDetectWorkspace: boolean;
};

// ---- Exported view-model helpers (testable without React) ----

export function validateSwarmDraft(draft: SwarmDraft): string | null {
  if (!draft.name.trim()) return "Name is required";
  if (!draft.leaderProviderId || !draft.leaderModel) return "Leader provider and model are required";
  if (!draft.defaultProviderId || !draft.defaultModel) return "Default provider and model are required";
  return null;
}

export function resetModelOnProviderChange(draft: SwarmDraft, providers: Array<{ id: string; models: string[] }>, providerKey: keyof SwarmDraft): SwarmDraft {
  const providerId = draft[providerKey] as string;
  const provider = providers.find((p) => p.id === providerId);
  const modelKey = providerKey.replace("ProviderId", "Model") as keyof SwarmDraft;
  if (provider && !provider.models.includes(draft[modelKey] as string)) {
    return { ...draft, [modelKey]: "" };
  }
  return draft;
}

function emptyDraft(): SwarmDraft {
  return { name: "", description: "", enabled: true, workspaceRoots: "", launchDirectory: "", agentDirectories: "", leaderProviderId: "", leaderModel: "", defaultProviderId: "", defaultModel: "", fallbackProviderId: "", fallbackModel: "", watchFiles: true, autoDetectWorkspace: false };
}

function SwarmForm({ providers, onSave, onCancel, busy }: { providers: GatewayProviderConfig[]; onSave: (input: any) => Promise<void>; onCancel: () => void; busy: boolean }) {
  const [draft, setDraft] = useState<SwarmDraft>(emptyDraft());
  const [validationError, setValidationError] = useState<string | null>(null);

  const update = <K extends keyof SwarmDraft>(key: K, value: SwarmDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    // when provider changes, reset the corresponding model if invalid
    if (key === "leaderProviderId" || key === "defaultProviderId" || key === "fallbackProviderId") {
      const provider = providers.find((p) => (p.id ?? p.name) === value);
      const modelKey = key.replace("ProviderId", "Model") as keyof SwarmDraft;
      if (provider && !provider.models.includes(draft[modelKey] as string)) {
        setDraft((d) => ({ ...d, [modelKey]: "" }));
      }
    }
  };

  const providerOptions = providers.map((p) => ({ id: p.id ?? p.name, name: p.name, models: p.models }));
  const modelsFor = (providerId: string) => providerOptions.find((p) => p.id === providerId)?.models ?? [];

  const save = () => {
    if (!draft.name.trim()) { setValidationError("Name is required"); return; }
    if (!draft.leaderProviderId || !draft.leaderModel) { setValidationError("Leader provider and model are required"); return; }
    if (!draft.defaultProviderId || !draft.defaultModel) { setValidationError("Default provider and model are required"); return; }
    setValidationError(null);
    onSave({
      name: draft.name.trim(),
      description: draft.description,
      enabled: draft.enabled,
      workspaceRoots: draft.workspaceRoots.split("\n").map((s) => s.trim()).filter(Boolean),
      launchDirectory: draft.launchDirectory.trim(),
      mainInstructionFile: "",
      agentDirectories: draft.agentDirectories.split("\n").map((s) => s.trim()).filter(Boolean),
      leaderProviderId: draft.leaderProviderId,
      leaderModel: draft.leaderModel,
      defaultProviderId: draft.defaultProviderId,
      defaultModel: draft.defaultModel,
      fallbackProviderId: draft.fallbackProviderId,
      fallbackModel: draft.fallbackModel,
      routingMode: "exact",
      autoDetectWorkspace: draft.autoDetectWorkspace,
      watchFiles: draft.watchFiles
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <Button onClick={onCancel} size="sm" variant="ghost">← Cancel</Button>
        <h2 className="text-lg font-semibold">Create Swarm</h2>
      </div>

      {validationError && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{validationError}</div>}

      <div className="grid max-w-2xl gap-4">
        <FormField label="Name" value={draft.name} onChange={(v) => update("name", v)} />
        <FormField label="Description" value={draft.description} onChange={(v) => update("description", v)} />
        <FormTextarea label="Workspace Roots (one per line)" value={draft.workspaceRoots} onChange={(v) => update("workspaceRoots", v)} />
        <FormField label="Launch Directory" value={draft.launchDirectory} onChange={(v) => update("launchDirectory", v)} />
        <FormTextarea label="Agent Directories (one per line)" value={draft.agentDirectories} onChange={(v) => update("agentDirectories", v)} />

        <ProviderModelField label="Leader" providerId={draft.leaderProviderId} model={draft.leaderModel} providers={providerOptions} onProvider={(v) => update("leaderProviderId", v)} onModel={(v) => update("leaderModel", v)} />
        <ProviderModelField label="Default" providerId={draft.defaultProviderId} model={draft.defaultModel} providers={providerOptions} onProvider={(v) => update("defaultProviderId", v)} onModel={(v) => update("defaultModel", v)} />
        <ProviderModelField label="Fallback (optional)" providerId={draft.fallbackProviderId} model={draft.fallbackModel} providers={providerOptions} onProvider={(v) => update("fallbackProviderId", v)} onModel={(v) => update("fallbackModel", v)} />

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => update("enabled", e.target.checked)} /> Enabled</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.watchFiles} onChange={(e) => update("watchFiles", e.target.checked)} /> Watch files for changes</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.autoDetectWorkspace} onChange={(e) => update("autoDetectWorkspace", e.target.checked)} /> Auto-detect workspace</label>

        <div className="flex gap-2">
          <Button onClick={save} disabled={busy} size="sm">Save</Button>
          <Button onClick={onCancel} disabled={busy} size="sm" variant="ghost">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-muted-foreground">{label}</span>
      <input className="rounded-md border border-border bg-background px-3 py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function FormTextarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-muted-foreground">{label}</span>
      <textarea className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ProviderModelField({ label, providerId, model, providers, onProvider, onModel }: {
  label: string; providerId: string; model: string;
  providers: Array<{ id: string; name: string; models: string[] }>;
  onProvider: (v: string) => void; onModel: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted-foreground">{label} Provider</span>
        <select className="rounded-md border border-border bg-background px-3 py-1.5 text-sm" value={providerId} onChange={(e) => onProvider(e.target.value)}>
          <option value="">— Select —</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted-foreground">{label} Model</span>
        <select className="rounded-md border border-border bg-background px-3 py-1.5 text-sm" value={model} onChange={(e) => onModel(e.target.value)} disabled={!providerId}>
          <option value="">— Select —</option>
          {(providers.find((p) => p.id === providerId)?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
    </div>
  );
}
