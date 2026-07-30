/**
 * Every ElevenLabs API call lives in this file.
 *
 * Paths and payload shapes were verified against @elevenlabs/elevenlabs-js
 * v2.59.0, which is code-generated from the same OpenAPI spec that backs the
 * live API. They have still never been exercised against a real key, so a
 * runtime surprise is possible — `npm run preflight` is the check for that.
 *
 * Reference: https://elevenlabs.io/docs/api-reference/agents/create
 */

const BASE_URL = "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${path} → ${status}: ${body}`);
    this.name = "ElevenLabsError";
  }
}

export class ElevenLabsClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    if (!response.ok) throw new ElevenLabsError(response.status, path, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Cheapest authenticated call — used by preflight to validate the key. */
  getUser() {
    return this.request<{ subscription?: { tier?: string } }>("/v1/user");
  }

  listAgents() {
    return this.request<{ agents: { agent_id: string; name: string }[] }>(
      "/v1/convai/agents",
    );
  }

  deleteAgent(agentId: string) {
    return this.request<unknown>(`/v1/convai/agents/${agentId}`, { method: "DELETE" });
  }

  listKnowledgeBase() {
    return this.request<{ documents: { id: string; name: string }[] }>(
      "/v1/convai/knowledge-base",
    );
  }

  getVoice(voiceId: string) {
    return this.request<{ voice_id: string; name: string }>(`/v1/voices/${voiceId}`);
  }

  listPhoneNumbers() {
    return this.request<unknown[]>("/v1/convai/phone-numbers");
  }

  createAgent(body: unknown) {
    return this.request<{ agent_id: string }>("/v1/convai/agents/create", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateAgent(agentId: string, body: unknown) {
    return this.request<{ agent_id: string }>(`/v1/convai/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Workspace secrets. Webhook tool headers reference these by ID, not by
   * name, so sync has to resolve the name it knows into the ID the API wants.
   */
  listSecrets() {
    return this.request<{ secrets: { secret_id: string; name: string }[] }>(
      "/v1/convai/secrets",
    );
  }

  listTools() {
    return this.request<{
      tools: { id: string; tool_config?: { name?: string } }[];
    }>("/v1/convai/tools");
  }

  createTool(toolConfig: unknown) {
    return this.request<{ id: string }>("/v1/convai/tools", {
      method: "POST",
      body: JSON.stringify({ tool_config: toolConfig }),
    });
  }

  updateTool(toolId: string, toolConfig: unknown) {
    return this.request<{ id: string }>(`/v1/convai/tools/${toolId}`, {
      method: "PATCH",
      body: JSON.stringify({ tool_config: toolConfig }),
    });
  }

  createKnowledgeBaseText(name: string, text: string) {
    return this.request<{ id: string; name: string }>(
      "/v1/convai/knowledge-base/text",
      { method: "POST", body: JSON.stringify({ name, text }) },
    );
  }

  deleteKnowledgeBaseDocument(documentId: string) {
    return this.request<unknown>(`/v1/convai/knowledge-base/${documentId}`, {
      method: "DELETE",
    });
  }

  /** Used by the eval harness — runs a conversation without placing a call. */
  simulateConversation(agentId: string, body: unknown) {
    return this.request<{
      simulated_conversation: { role: string; message: string }[];
    }>(`/v1/convai/agents/${agentId}/simulate-conversation`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
