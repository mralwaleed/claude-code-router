/** Pure view-model helpers for the Swarm UI — testable without React/DOM. */

export type SwarmDraft = {
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

export function emptyDraft(): SwarmDraft {
  return { name: "", description: "", enabled: true, workspaceRoots: "", launchDirectory: "", agentDirectories: "", leaderProviderId: "", leaderModel: "", defaultProviderId: "", defaultModel: "", fallbackProviderId: "", fallbackModel: "", watchFiles: true, autoDetectWorkspace: false };
}

export function validateSwarmDraft(draft: SwarmDraft): string | null {
  if (!draft.name.trim()) return "Name is required";
  if (!draft.leaderProviderId || !draft.leaderModel) return "Leader provider and model are required";
  if (!draft.defaultProviderId || !draft.defaultModel) return "Default provider and model are required";
  return null;
}

export function resetModelOnProviderChange(
  draft: SwarmDraft,
  providers: Array<{ id: string; models: string[] }>,
  providerKey: keyof SwarmDraft
): SwarmDraft {
  const providerId = draft[providerKey] as string;
  const provider = providers.find((p) => p.id === providerId);
  const modelKey = providerKey.replace("ProviderId", "Model") as keyof SwarmDraft;
  if (provider && !provider.models.includes(draft[modelKey] as string)) {
    return { ...draft, [modelKey]: "" };
  }
  return draft;
}
