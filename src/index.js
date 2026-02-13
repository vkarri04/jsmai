import Resolver from "@forge/resolver";
import api, { storage, route } from "@forge/api";

const resolver = new Resolver();

// ─── General Settings ────────────────────────────────────────────────

resolver.define("saveSettings", async ({ payload }) => {
  await storage.set("agentSettings", payload);
  return { success: true };
});

resolver.define("getSettings", async () => {
  const settings = await storage.get("agentSettings");
  return settings || { enableChatbot: false, fastApiUrl: "" };
});

// ─── Project-level Chat Settings ─────────────────────────────────────

resolver.define("getProjects", async () => {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/project/search?typeKey=service_desk&maxResults=100`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      const text = await response.text();
      return { error: `Failed to fetch projects: ${response.status} — ${text}` };
    }

    const data = await response.json();
    const values = data.values || [];

    return {
      projects: values.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        avatarUrl: p.avatarUrls?.["48x48"] || p.avatarUrls?.["32x32"] || "",
      })),
    };
  } catch (err) {
    return { error: `Resolver error: ${err.message || String(err)}` };
  }
});

resolver.define("getProjectChatSettings", async () => {
  const settings = await storage.get("projectChatSettings");
  return settings || {};
});

resolver.define("saveProjectChatSettings", async ({ payload }) => {
  await storage.set("projectChatSettings", payload);
  return { success: true };
});

// ─── LLM / AI Model Settings ────────────────────────────────────────

resolver.define("getLLMSettings", async () => {
  const settings = await storage.get("llmSettings");
  return settings || { provider: "openai", model: "", apiKey: "" };
});

resolver.define("saveLLMSettings", async ({ payload }) => {
  const { provider, model, apiKey } = payload;

  if (!provider || !["openai", "claude"].includes(provider)) {
    return { error: "Invalid provider. Must be 'openai' or 'claude'." };
  }
  if (!model) {
    return { error: "Model is required." };
  }
  if (!apiKey) {
    return { error: "API key is required." };
  }

  await storage.set("llmSettings", { provider, model, apiKey });
  return { success: true };
});

// ─── Chat ────────────────────────────────────────────────────────────

resolver.define("chat", async ({ payload }) => {
  const settings = await storage.get("agentSettings");

  if (!settings?.enableChatbot) {
    return { error: "Chatbot is disabled by admin." };
  }

  if (!settings?.fastApiUrl) {
    return { error: "FastAPI URL not configured." };
  }

  // Check project-level setting if projectId is provided
  if (payload?.projectId) {
    const projectSettings = await storage.get("projectChatSettings");
    if (projectSettings && !projectSettings[payload.projectId]) {
      return { error: "Chat agent is not enabled for this project." };
    }
  }

  // Retrieve LLM settings and include them in the backend request
  const llmSettings = await storage.get("llmSettings");
  const chatPayload = {
    ...payload,
    llm: llmSettings
      ? { provider: llmSettings.provider, model: llmSettings.model, apiKey: llmSettings.apiKey }
      : undefined,
  };

  const response = await fetch(`${settings.fastApiUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatPayload),
  });

  const data = await response.json();
  return data;
});

export const handler = resolver.getDefinitions();